import type { Logger } from "../logger";

export enum BridgeState {
  ACTIVE_CONVERSATION = "active_conversation",
  AWAITING_FAREWELL = "awaiting_farewell",
  CLOSING = "closing",
}

// Allowed forward transitions. Reverse transitions are not permitted; the
// state machine moves strictly forward over a call's lifetime.
const ALLOWED: Record<BridgeState, BridgeState[]> = {
  [BridgeState.ACTIVE_CONVERSATION]: [BridgeState.AWAITING_FAREWELL, BridgeState.CLOSING],
  [BridgeState.AWAITING_FAREWELL]: [BridgeState.CLOSING],
  [BridgeState.CLOSING]: [],
};

export class BridgeStateMachine {
  private state: BridgeState = BridgeState.ACTIVE_CONVERSATION;

  constructor(public readonly callId: string, private readonly logger: Logger) {}

  getState(): BridgeState {
    return this.state;
  }

  isActive(): boolean {
    return this.state === BridgeState.ACTIVE_CONVERSATION;
  }

  isAwaitingFarewell(): boolean {
    return this.state === BridgeState.AWAITING_FAREWELL;
  }

  isClosing(): boolean {
    return this.state === BridgeState.CLOSING;
  }

  // Returns true if the transition happened, false if it was a no-op
  // (already in target state) or an illegal backward move (logged + ignored).
  transitionTo(next: BridgeState): boolean {
    if (next === this.state) return false;
    if (!ALLOWED[this.state].includes(next)) {
      this.logger.warn("illegal state transition ignored", {
        callId: this.callId,
        from: this.state,
        to: next,
      });
      return false;
    }
    const prev = this.state;
    this.state = next;
    this.logger.info("bridge.state.transition", { callId: this.callId, from: prev, to: next });
    return true;
  }
}
