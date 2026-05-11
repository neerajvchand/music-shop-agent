import type { WebSocket } from "ws";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BridgeConfig } from "../config";
import type { Logger } from "../logger";
import { composeSystemPrompt, buildCallContext } from "../prompts/composer";
import { buildToolDefinitions } from "../prompts/tools";
import { logCall } from "../supabase/calls";
import { getShopByTwilioNumber, type Shop } from "../supabase/shops";
import { TwilioActivityTracker, TwilioMediaStreamAdapter } from "../twilio/adapter";
import { XAIClient } from "../xai/client";
import { buildSessionConfig } from "../xai/session";
import { AsyncEvent } from "./async-event";
import { runFarewellWatchdog } from "./farewell";
import { handleFunctionCall } from "./function-handler";
import { runSilenceWatchdog } from "./silence-watchdog";
import { BridgeState, BridgeStateMachine } from "./state-machine";
import { runTimeoutWatchdog } from "./timeout-watchdog";

// Per-call orchestration. Wires Twilio Media Streams to xAI, runs three
// watchdogs (farewell, silence, hard call timeout), and persists a `calls`
// row on call end.
//
// Lifecycle:
//   open -> Twilio start -> resolve shop (from custom Parameter or earlier
//   lookup) -> compose system prompt -> xAI connect -> xAI configure
//   session -> wire handlers -> watchdogs run in parallel -> Twilio close
//   -> CLOSING -> drain -> close xAI -> log call.

export interface HandleCallParams {
  twilioWs: WebSocket;
  callId: string;
  config: BridgeConfig;
  sb: SupabaseClient;
  logger: Logger;
}

export async function handleCall(params: HandleCallParams): Promise<void> {
  const { twilioWs, callId, config, sb, logger: parentLogger } = params;
  const logger = parentLogger.child({ callId });

  const state = new BridgeStateMachine(callId, logger);
  const responseDoneEvent = new AsyncEvent();
  const tracker = new TwilioActivityTracker();
  const transcript: string[] = [];

  let streamSid: string | undefined;
  let twilioCallSid: string | null = null;
  let callerPhone: string | null = null;
  const startedAt = new Date();

  const tw = new TwilioMediaStreamAdapter(twilioWs);

  // Critical ordering: register the start handler BEFORE any awaits.
  const startReceived = new AsyncEvent();
  let shopSlugFromParams: string | undefined;
  let twilioToNumber: string | undefined;
  tw.on("start", (msg) => {
    streamSid = msg.start.streamSid;
    twilioCallSid = msg.start.callSid;
    const cp = msg.start.customParameters || {};
    shopSlugFromParams = cp.shop as string | undefined;
    twilioToNumber = cp.to as string | undefined;
    callerPhone = (cp.from as string | undefined) ?? null;
    logger.info("twilio.start", { streamSid, twilioCallSid, shopSlugFromParams });
    startReceived.set();
  });

  // Wait briefly for Twilio start. Without it we can't identify the shop.
  try {
    await startReceived.waitFor(10_000);
  } catch {
    logger.error("twilio.start.timeout", {});
    twilioWs.close();
    return;
  }

  // Shop resolution. Prefer slug-from-customParameters (matches Python
  // bridge's TwiML pattern); fall back to twilio_number lookup if needed.
  let shop: Shop | null = null;
  if (shopSlugFromParams) {
    const { data } = await sb.from("shops").select("*").eq("slug", shopSlugFromParams).eq("status", "active").limit(1);
    if (data && data.length > 0) shop = data[0] as Shop;
  }
  if (!shop && twilioToNumber) {
    shop = await getShopByTwilioNumber(sb, twilioToNumber, logger);
  }
  if (!shop) {
    logger.error("shop.not_found", { shopSlugFromParams, twilioToNumber });
    twilioWs.close();
    return;
  }
  logger.info("shop.resolved", { shopId: shop.id, slug: shop.slug });

  // Build prompt + tools.
  const today = new Date().toISOString().slice(0, 10);
  const ctx = buildCallContext({ shop, callerPhone, today, logger });
  const instructions = await composeSystemPrompt({ sb, shop, context: ctx, logger });
  const tools = buildToolDefinitions();

  // Connect to xAI and configure the session.
  const xai = new XAIClient({
    apiKey: config.xaiApiKey,
    apiUrl: config.xaiApiUrl,
    model: config.xaiModel,
    callId,
    logger,
  });

  try {
    await xai.connect();
    await xai.configureSession(
      buildSessionConfig({
        instructions,
        voice: shop.voice_id || "rex",
        tools,
      }),
    );
  } catch (err) {
    logger.error("xai.bringup.failed", { err });
    twilioWs.close();
    return;
  }

  // Wire audio + events.
  tw.on("media", (msg) => {
    if (state.isClosing()) return;
    tracker.recordActivity();
    if (msg.media.track === "inbound") xai.appendAudio(msg.media.payload);
  });

  xai.onAudio((mulawBase64) => {
    if (!streamSid) return;
    tw.send({ event: "media", streamSid, media: { payload: mulawBase64 } });
  });

  xai.onSpeechStarted(() => {
    if (!streamSid) return;
    // Drop queued bot audio so the caller can interrupt cleanly.
    tw.send({ event: "clear", streamSid });
  });

  xai.onResponseDone(() => {
    if (state.isAwaitingFarewell()) responseDoneEvent.set();
  });

  xai.onTranscript((text, role) => {
    if (!text) return;
    transcript.push(`${role === "caller" ? "User" : "Bot"}: ${text}`);
  });

  xai.onFunctionCall((call) => {
    handleFunctionCall(call, {
      shop,
      state,
      xai,
      dashboardBaseUrl: config.dashboardBaseUrl,
      agentApiSecret: config.agentApiSecret,
      logger,
    }).catch((err) => logger.error("function.dispatch.error", { err }));
  });

  xai.onError(() => {
    if (state.isActive()) state.transitionTo(BridgeState.AWAITING_FAREWELL);
  });

  // Trigger the initial greeting — bridge initiates so the agent speaks first.
  xai.sendItem({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `Greet the caller now. Use the shop's configured greeting: "${shop.greeting}"` }],
  });
  xai.triggerResponse();

  // Watchdogs run in parallel; we await them all at call end.
  const watchdogs = Promise.all([
    runFarewellWatchdog({
      state,
      injector: xai,
      farewellText: shop.farewell,
      responseDoneEvent,
      farewellSafetyTimeoutMs: config.farewellSafetyTimeoutMs,
      logger,
    }),
    runSilenceWatchdog({
      state,
      tracker,
      silenceTimeoutMs: config.silenceTimeoutMs,
      onTimeout: () => state.transitionTo(BridgeState.AWAITING_FAREWELL),
      logger,
    }),
    runTimeoutWatchdog({
      state,
      callTimeoutMs: config.callTimeoutMs,
      onTimeout: () => state.transitionTo(BridgeState.AWAITING_FAREWELL),
      logger,
    }),
  ]);

  // Wait for Twilio close.
  await new Promise<void>((resolve) => {
    twilioWs.on("close", () => {
      logger.info("twilio.close", {});
      state.transitionTo(BridgeState.CLOSING);
      resolve();
    });
  });

  await watchdogs.catch((err) => logger.warn("watchdogs.settled.error", { err }));

  // Drain so any in-flight farewell audio reaches Twilio before we tear down.
  await sleep(config.goodbyeDrainMs);
  await xai.close(1000);

  await logCall(
    sb,
    {
      shop_id: shop.id,
      twilio_call_sid: twilioCallSid,
      started_at: startedAt,
      ended_at: new Date(),
      caller_phone: callerPhone,
      transcript: transcript.join("\n"),
    },
    logger,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
