import { describe, it, expect, vi } from "vitest";
import { AsyncEvent, AsyncEventTimeoutError } from "../src/bridge/async-event";

describe("AsyncEvent", () => {
  it("resolves immediately if already set", async () => {
    const e = new AsyncEvent();
    e.set();
    await expect(e.waitFor(50)).resolves.toBeUndefined();
  });

  it("resolves when set() is called while waiter is pending", async () => {
    const e = new AsyncEvent();
    const waitPromise = e.waitFor(1000);
    setTimeout(() => e.set(), 20);
    await expect(waitPromise).resolves.toBeUndefined();
  });

  it("REJECTS with AsyncEventTimeoutError when timeout fires before set()", async () => {
    const e = new AsyncEvent();
    await expect(e.waitFor(100)).rejects.toBeInstanceOf(AsyncEventTimeoutError);
  });

  it("rejection includes the timeout value in the error", async () => {
    const e = new AsyncEvent();
    try {
      await e.waitFor(150);
      expect.fail("waitFor should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(AsyncEventTimeoutError);
      expect((err as AsyncEventTimeoutError).timeoutMs).toBe(150);
      expect((err as Error).message).toContain("150");
    }
  });

  it("calling code can catch the rejection without crashing", async () => {
    // Simulates the farewell watchdog's catch-and-warn pattern.
    const e = new AsyncEvent();
    const warn = vi.fn();
    let crashed = false;

    try {
      await e.waitFor(100).catch((err: Error) => {
        warn("timeout caught", err.message);
      });
    } catch {
      crashed = true;
    }

    expect(crashed).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("timeout caught", expect.stringContaining("100"));
  });

  it("clear() resets a previously-set event so a fresh waitFor blocks again", async () => {
    const e = new AsyncEvent();
    e.set();
    await expect(e.waitFor(50)).resolves.toBeUndefined();
    e.clear();
    await expect(e.waitFor(50)).rejects.toBeInstanceOf(AsyncEventTimeoutError);
  });

  it("set() resolves multiple concurrent waiters", async () => {
    const e = new AsyncEvent();
    const a = e.waitFor(1000);
    const b = e.waitFor(1000);
    const c = e.waitFor(1000);
    setTimeout(() => e.set(), 20);
    await expect(Promise.all([a, b, c])).resolves.toEqual([undefined, undefined, undefined]);
  });
});
