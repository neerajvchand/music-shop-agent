import { describe, it, expect, vi } from "vitest";
import { BridgeState, BridgeStateMachine } from "../src/bridge/state-machine";
import type { Logger } from "../src/logger";

function fakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fakeLogger(),
  };
}

describe("BridgeStateMachine", () => {
  it("starts in ACTIVE_CONVERSATION", () => {
    const sm = new BridgeStateMachine("c1", fakeLogger());
    expect(sm.getState()).toBe(BridgeState.ACTIVE_CONVERSATION);
    expect(sm.isActive()).toBe(true);
    expect(sm.isAwaitingFarewell()).toBe(false);
    expect(sm.isClosing()).toBe(false);
  });

  it("transitions ACTIVE -> AWAITING_FAREWELL -> CLOSING", () => {
    const log = fakeLogger();
    const sm = new BridgeStateMachine("c1", log);
    expect(sm.transitionTo(BridgeState.AWAITING_FAREWELL)).toBe(true);
    expect(sm.isAwaitingFarewell()).toBe(true);
    expect(sm.transitionTo(BridgeState.CLOSING)).toBe(true);
    expect(sm.isClosing()).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      "bridge.state.transition",
      expect.objectContaining({ from: BridgeState.ACTIVE_CONVERSATION, to: BridgeState.AWAITING_FAREWELL }),
    );
  });

  it("allows ACTIVE -> CLOSING directly (twilio hang-up before farewell)", () => {
    const sm = new BridgeStateMachine("c1", fakeLogger());
    expect(sm.transitionTo(BridgeState.CLOSING)).toBe(true);
    expect(sm.isClosing()).toBe(true);
  });

  it("rejects illegal backward transitions and logs a warning", () => {
    const log = fakeLogger();
    const sm = new BridgeStateMachine("c1", log);
    sm.transitionTo(BridgeState.AWAITING_FAREWELL);
    expect(sm.transitionTo(BridgeState.ACTIVE_CONVERSATION)).toBe(false);
    expect(sm.isAwaitingFarewell()).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      "illegal state transition ignored",
      expect.objectContaining({ from: BridgeState.AWAITING_FAREWELL, to: BridgeState.ACTIVE_CONVERSATION }),
    );
  });

  it("rejects transitions out of CLOSING", () => {
    const sm = new BridgeStateMachine("c1", fakeLogger());
    sm.transitionTo(BridgeState.CLOSING);
    expect(sm.transitionTo(BridgeState.AWAITING_FAREWELL)).toBe(false);
    expect(sm.transitionTo(BridgeState.ACTIVE_CONVERSATION)).toBe(false);
    expect(sm.isClosing()).toBe(true);
  });

  it("no-ops self-transitions and returns false", () => {
    const sm = new BridgeStateMachine("c1", fakeLogger());
    expect(sm.transitionTo(BridgeState.ACTIVE_CONVERSATION)).toBe(false);
  });
});
