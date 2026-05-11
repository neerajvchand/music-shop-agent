import type { Logger } from "../logger";
import type { BridgeStateMachine } from "./state-machine";

// Hard call-duration ceiling. After CALL_TIMEOUT_MS the bridge initiates the
// farewell flow regardless of caller activity. Catches runaway calls (stuck
// LLM, broken Twilio stream, malicious caller squatting on the line).
export async function runTimeoutWatchdog(params: {
  state: BridgeStateMachine;
  callTimeoutMs: number;
  onTimeout: () => void;
  logger: Logger;
}): Promise<void> {
  const { state, callTimeoutMs, onTimeout, logger } = params;
  await sleep(callTimeoutMs);
  if (state.isActive()) {
    logger.warn("call.timeout", { callId: state.callId, callTimeoutMs });
    onTimeout();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
