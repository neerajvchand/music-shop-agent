import type { Logger } from "../logger";
import type { TwilioActivityTracker } from "../twilio/adapter";
import type { BridgeStateMachine } from "./state-machine";

// Polls the activity tracker every 1s. When idle exceeds SILENCE_TIMEOUT_MS,
// invokes onTimeout (which should transition the state machine to
// AWAITING_FAREWELL). Exits cleanly once the state leaves ACTIVE_CONVERSATION.
export async function runSilenceWatchdog(params: {
  state: BridgeStateMachine;
  tracker: TwilioActivityTracker;
  silenceTimeoutMs: number;
  onTimeout: () => void;
  logger: Logger;
}): Promise<void> {
  const { state, tracker, silenceTimeoutMs, onTimeout, logger } = params;

  while (state.isActive()) {
    if (tracker.getIdleMs() >= silenceTimeoutMs) {
      logger.info("silence.timeout", { callId: state.callId, silenceTimeoutMs });
      onTimeout();
      return;
    }
    await sleep(1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
