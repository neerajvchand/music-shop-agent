import { describe, it, expect, vi } from "vitest";
import { AsyncEvent } from "../src/bridge/async-event";
import { runFarewellWatchdog } from "../src/bridge/farewell";
import { BridgeState, BridgeStateMachine } from "../src/bridge/state-machine";
import type { Logger } from "../src/logger";

function fakeLogger(): Logger {
  const fn = vi.fn();
  const log: Logger = {
    debug: fn,
    info: fn,
    warn: fn,
    error: fn,
    child: () => log,
  };
  return log;
}

describe("runFarewellWatchdog — eager bridge-driven farewell", () => {
  it("injects exactly once when state enters AWAITING_FAREWELL, then resolves on responseDoneEvent.set()", async () => {
    const state = new BridgeStateMachine("c1", fakeLogger());
    const responseDone = new AsyncEvent();
    const injector = { injectFarewell: vi.fn() };

    state.transitionTo(BridgeState.AWAITING_FAREWELL);

    const watchdog = runFarewellWatchdog({
      state,
      injector,
      farewellText: "Bye!",
      responseDoneEvent: responseDone,
      farewellSafetyTimeoutMs: 5000,
      logger: fakeLogger(),
    });

    // Allow microtasks + the first poll cycle to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(injector.injectFarewell).toHaveBeenCalledTimes(1);
    expect(injector.injectFarewell).toHaveBeenCalledWith("Bye!");

    responseDone.set();
    await expect(watchdog).resolves.toBeUndefined();
  });

  it("on timeout, logs a warning and does NOT throw", async () => {
    const log = fakeLogger();
    const state = new BridgeStateMachine("c1", fakeLogger());
    state.transitionTo(BridgeState.AWAITING_FAREWELL);

    const injector = { injectFarewell: vi.fn() };
    const responseDone = new AsyncEvent();

    // Short timeout — responseDone never set.
    await expect(
      runFarewellWatchdog({
        state,
        injector,
        farewellText: "Bye!",
        responseDoneEvent: responseDone,
        farewellSafetyTimeoutMs: 100,
        logger: log,
      }),
    ).resolves.toBeUndefined();

    expect(injector.injectFarewell).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "farewell.response_done.timeout",
      expect.objectContaining({ farewellSafetyTimeoutMs: 100 }),
    );
  });

  it("exits without injecting if state is already CLOSING", async () => {
    const state = new BridgeStateMachine("c1", fakeLogger());
    state.transitionTo(BridgeState.CLOSING);

    const injector = { injectFarewell: vi.fn() };
    const responseDone = new AsyncEvent();

    await runFarewellWatchdog({
      state,
      injector,
      farewellText: "Bye!",
      responseDoneEvent: responseDone,
      farewellSafetyTimeoutMs: 5000,
      logger: fakeLogger(),
    });

    expect(injector.injectFarewell).not.toHaveBeenCalled();
  });

  it("clears the response-done event before injecting so a stale prior set() doesn't short-circuit", async () => {
    const state = new BridgeStateMachine("c1", fakeLogger());
    state.transitionTo(BridgeState.AWAITING_FAREWELL);

    const injector = { injectFarewell: vi.fn() };
    const responseDone = new AsyncEvent();
    responseDone.set(); // stale latched state from a previous turn

    let injectedBeforeSet = false;
    injector.injectFarewell.mockImplementation(() => {
      injectedBeforeSet = !responseDone.state;
    });

    const watchdog = runFarewellWatchdog({
      state,
      injector,
      farewellText: "Bye!",
      responseDoneEvent: responseDone,
      farewellSafetyTimeoutMs: 100,
      logger: fakeLogger(),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(injectedBeforeSet).toBe(true); // event was cleared before injectFarewell ran

    // Let it time out gracefully.
    await watchdog;
  });

  it("uses fallback text and warns when farewellText is empty", async () => {
    const log = fakeLogger();
    const state = new BridgeStateMachine("c1", fakeLogger());
    state.transitionTo(BridgeState.AWAITING_FAREWELL);

    const injector = { injectFarewell: vi.fn() };
    const responseDone = new AsyncEvent();
    responseDone.set();

    await runFarewellWatchdog({
      state,
      injector,
      farewellText: "",
      responseDoneEvent: responseDone,
      farewellSafetyTimeoutMs: 100,
      logger: log,
    });

    expect(log.warn).toHaveBeenCalledWith("farewell.text.missing", expect.any(Object));
    expect(injector.injectFarewell).toHaveBeenCalledWith("Thank you for calling. Goodbye.");
  });
});
