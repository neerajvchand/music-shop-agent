// Promise-based equivalent of Python's asyncio.Event.
//
// set()    -> resolves all current waiters, latches the event "set" until clear()
// clear()  -> resets to unset; future waitFor calls will block again
// waitFor(timeoutMs)
//          -> if already set, resolves immediately
//          -> otherwise resolves when set() is called
//          -> REJECTS with AsyncEventTimeoutError after timeoutMs if neither has happened
//
// The rejection-on-timeout contract is required by the farewell watchdog:
// the caller must catch the rejection and log a warning, not propagate it
// as an unhandled rejection.

export class AsyncEventTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`AsyncEvent timeout after ${timeoutMs}ms`);
    this.name = "AsyncEventTimeoutError";
  }
}

type Waiter = { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

export class AsyncEvent {
  private isSet = false;
  private waiters: Waiter[] = [];

  set(): void {
    this.isSet = true;
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  clear(): void {
    this.isSet = false;
  }

  get state(): boolean {
    return this.isSet;
  }

  waitFor(timeoutMs: number): Promise<void> {
    if (this.isSet) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new AsyncEventTimeoutError(timeoutMs));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}
