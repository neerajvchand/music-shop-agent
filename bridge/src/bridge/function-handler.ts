import type { Logger } from "../logger";
import { AgentApiError, checkAvailability, createBooking } from "../http/agent-api";
import type { AgentApiContext } from "../http/agent-api";
import type { Shop } from "../supabase/shops";
import type { XAIClient } from "../xai/client";
import type { XaiFunctionCall } from "../xai/types";
import { BridgeState, type BridgeStateMachine } from "./state-machine";

// Dispatch xAI function calls. Three tools:
//   end_call             -> bridge state transition; bridge speaks farewell
//   check_availability   -> HMAC'd POST to /api/agent/check-availability
//   create_booking       -> HMAC'd POST to /api/agent/create-booking
//
// Result format mirrors the Python bridge's canonical error shape:
//   { error: <code>, message: <readable text> } on failure
//   <route's JSON body> on success
// The LLM is prompt-instructed to read the `message` field aloud on error.

export interface FunctionHandlerContext {
  shop: Shop;
  state: BridgeStateMachine;
  xai: XAIClient;
  dashboardBaseUrl: string;
  agentApiSecret: string;
  logger: Logger;
}

export async function handleFunctionCall(call: XaiFunctionCall, ctx: FunctionHandlerContext): Promise<void> {
  const { shop, state, xai, logger } = ctx;
  const apiCtx: AgentApiContext = {
    dashboardBaseUrl: ctx.dashboardBaseUrl,
    agentApiSecret: ctx.agentApiSecret,
    shopId: shop.id,
    logger,
  };

  logger.info("function.call", { callId: state.callId, name: call.name, args: call.args });

  let resultPayload: unknown;
  try {
    if (call.name === "end_call") {
      state.transitionTo(BridgeState.AWAITING_FAREWELL);
      resultPayload = { status: "accepted, deliver farewell now" };
    } else if (call.name === "check_availability") {
      resultPayload = await checkAvailability(apiCtx, call.args as { date: string; durationMinutes: number; timezone?: string });
    } else if (call.name === "create_booking") {
      resultPayload = await createBooking(apiCtx, call.args as {
        customerName: string;
        customerPhone: string;
        service: string;
        startTime: string;
        durationMinutes: number;
        notes?: string;
      });
    } else {
      logger.warn("function.unknown", { callId: state.callId, name: call.name });
      resultPayload = { error: "unknown_function", message: `Function ${call.name} is not implemented.` };
    }
  } catch (err) {
    if (err instanceof AgentApiError) {
      // Surface the structured body if present so the LLM gets the right message.
      const body = (err.body && typeof err.body === "object") ? (err.body as Record<string, unknown>) : null;
      resultPayload = body ?? {
        error: err.status === 409 ? "slot_taken" : "agent_api_error",
        message: err.message,
      };
    } else {
      logger.error("function.error", { callId: state.callId, name: call.name, err });
      resultPayload = { error: "bridge_error", message: "Sorry, I had trouble completing that." };
    }
  }

  const output = JSON.stringify(resultPayload);
  logger.info("function.result", { callId: state.callId, name: call.name, preview: output.slice(0, 200) });
  xai.sendFunctionResult(call.callId, output);
}
