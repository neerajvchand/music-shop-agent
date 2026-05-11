import type { Logger } from "../logger";
import type { AsyncEvent } from "./async-event";
import type { BridgeStateMachine } from "./state-machine";

// Minimal interface so this module doesn't import the concrete XAIClient
// (keeps farewell.test.ts trivial to mock).
export interface FarewellInjector {
  injectFarewell(text: string): void;
}

// Eager bridge-driven farewell.
//
// 1. Poll the state machine until AWAITING_FAREWELL entry (or exit early
//    if CLOSING happened first — e.g. Twilio hung up before end_call).
// 2. Clear the response-done event BEFORE injecting, defensive against a
//    stray earlier `response.done` having latched the event "set".
// 3. Inject the configured farewell text via the system-role exact-text
//    pattern (XAIClient.injectFarewell).
// 4. Single watchdog wait on the response-done event with the configured
//    timeout. On timeout we log a warning and return — GOODBYE_DRAIN_MS in
//    the handler covers the gap between "generation done" and "audio fully
//    delivered to Twilio".

const POLL_INTERVAL_MS = 200;
const FALLBACK_FAREWELL = "Thank you for calling. Goodbye.";

export async function runFarewellWatchdog(params: {
  state: BridgeStateMachine;
  injector: FarewellInjector;
  farewellText: string | undefined;
  responseDoneEvent: AsyncEvent;
  farewellSafetyTimeoutMs: number;
  logger: Logger;
}): Promise<void> {
  const { state, injector, responseDoneEvent, farewellSafetyTimeoutMs, logger } = params;
  const callId = state.callId;

  // Wait for AWAITING_FAREWELL entry. If we land in CLOSING first, the call
  // already ended (caller hang-up before end_call); nothing to inject.
  while (!state.isAwaitingFarewell()) {
    if (state.isClosing()) {
      logger.info("farewell.skipped.closing", { callId });
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!params.farewellText || params.farewellText.trim().length === 0) {
    logger.warn("farewell.text.missing", {
      callId,
      note: "shop.farewell is empty — using fallback. Phase 2 prompt-tuning should set this.",
    });
  }
  const text = (params.farewellText && params.farewellText.trim()) || FALLBACK_FAREWELL;

  // Clear BEFORE injecting — avoids racing with a previously-set event.
  responseDoneEvent.clear();

  try {
    injector.injectFarewell(text);
    logger.info("farewell.injected", { callId, text });
  } catch (err) {
    logger.error("farewell.inject.error", { callId, err });
    return;
  }

  try {
    await responseDoneEvent.waitFor(farewellSafetyTimeoutMs);
    logger.info("farewell.response_done", { callId });
  } catch (err) {
    logger.warn("farewell.response_done.timeout", {
      callId,
      farewellSafetyTimeoutMs,
      note: "audio likely arrives during goodbye drain",
      err: (err as Error).message,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
