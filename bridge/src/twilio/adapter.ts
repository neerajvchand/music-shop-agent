import type { WebSocket } from "ws";
import type { TwilioStreamAction, TwilioStreamMessage, TwilioStreamMessageType } from "./types";

// Lightweight typed wrapper around the raw Twilio Media Streams WebSocket.
// Adapted from xai-cookbook/telephony/xai/src/twilio.ts but exposes a single
// shared message listener and a registered handler map, so we don't attach
// a new `on('message')` per `.on(event, fn)` call.

type Handler<E extends TwilioStreamMessageType> = (
  msg: Extract<TwilioStreamMessage, { event: E }>,
) => void;

export class TwilioMediaStreamAdapter {
  streamSid: string | undefined;
  private handlers: { [E in TwilioStreamMessageType]?: Array<Handler<E>> } = {};

  constructor(private readonly ws: WebSocket) {
    this.ws.on("message", (data) => this.dispatch(data));
  }

  send(action: TwilioStreamAction): void {
    this.ws.send(JSON.stringify(action));
  }

  on<E extends TwilioStreamMessageType>(event: E, handler: Handler<E>): void {
    const bucket = (this.handlers[event] ?? []) as Array<Handler<E>>;
    bucket.push(handler);
    this.handlers[event] = bucket as never;
  }

  private dispatch(data: unknown): void {
    let parsed: TwilioStreamMessage;
    try {
      const text = typeof data === "string" ? data : (data as Buffer).toString();
      parsed = JSON.parse(text) as TwilioStreamMessage;
    } catch {
      return;
    }
    const handlers = this.handlers[parsed.event] as Array<Handler<typeof parsed.event>> | undefined;
    if (!handlers) return;
    for (const h of handlers) {
      try {
        (h as Handler<typeof parsed.event>)(parsed as never);
      } catch {
        // handler exceptions are swallowed; per-call handler does its own logging.
      }
    }
  }
}

// Tracks the timestamp of the last non-silence inbound media frame. Used by
// the silence watchdog. Twilio sends mu-law frames continuously even when
// the caller is silent; we treat the arrival of any inbound media frame as
// "activity" for now — Phase 2 may add VAD-aware idle detection.
export class TwilioActivityTracker {
  private lastActivity = Date.now();

  recordActivity(): void {
    this.lastActivity = Date.now();
  }

  getIdleMs(): number {
    return Date.now() - this.lastActivity;
  }
}
