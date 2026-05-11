import WebSocket from "ws";
import { AsyncEvent } from "../bridge/async-event";
import type { Logger } from "../logger";
import type {
  ConversationItem,
  SessionUpdatePayload,
  XaiFunctionCall,
  XaiInbound,
  XaiOutbound,
} from "./types";

// XAIClient wraps the xAI Voice Agent WebSocket.
//
// Lifecycle expected by callers:
//   1. new XAIClient(...)
//   2. await client.connect()         -> resolves after `conversation.created`
//   3. await client.configureSession() -> resolves after `session.updated`
//   4. wire handlers (onAudio, onFunctionCall, onResponseDone, ...)
//   5. start streaming caller audio via client.appendAudio(...)
//   6. on shutdown: await client.close(1000)
//
// The two-step connect/configureSession is required: per the cookbook,
// `session.update` should be sent in response to the server-initiated
// `conversation.created` event, and `session.updated` is what signals "safe
// to send caller audio".
//
// `onResponseDone` fires on the xAI `response.done` event. There is no
// `AgentAudioDone` event in the xAI protocol; `response.done` is the closest
// signal that an agent turn has finished generating. Audio delivery to
// Twilio may still be in flight in the network — the call handler uses
// GOODBYE_DRAIN_MS to cover that gap.

export type FunctionCallHandler = (call: XaiFunctionCall) => void | Promise<void>;
export type AudioHandler = (mulawBase64: string) => void;
export type SpeechStartedHandler = () => void;
export type ResponseDoneHandler = () => void;
export type TranscriptHandler = (text: string, role: "agent" | "caller") => void;
export type ErrorHandler = (err: { message?: string; type?: string } | Error) => void;
export type CloseHandler = (code: number) => void;

export interface XAIClientOptions {
  apiKey: string;
  apiUrl: string;
  model: string;
  callId: string;
  logger: Logger;
  connectTimeoutMs?: number;
  sessionConfiguredTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_CONFIG_TIMEOUT_MS = 5_000;

export class XAIClient {
  private ws: WebSocket | null = null;
  private readonly conversationCreated = new AsyncEvent();
  private readonly sessionConfigured = new AsyncEvent();

  private audioHandler: AudioHandler | null = null;
  private speechStartedHandler: SpeechStartedHandler | null = null;
  private responseDoneHandler: ResponseDoneHandler | null = null;
  private functionCallHandler: FunctionCallHandler | null = null;
  private transcriptHandler: TranscriptHandler | null = null;
  private errorHandler: ErrorHandler | null = null;
  private closeHandler: CloseHandler | null = null;

  private closed = false;

  constructor(private readonly opts: XAIClientOptions) {}

  async connect(): Promise<void> {
    const { apiKey, apiUrl, model, callId, logger } = this.opts;
    // The cookbook does not pass the model in the URL — it uses the API's
    // default model. xAI's docs say `model` can be specified via query string
    // on the realtime endpoint; we pass it so we pin to the production model.
    const url = appendQuery(apiUrl, { model });
    logger.info("xai.connect.start", { callId, url });

    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.ws = ws;

    const timeoutMs = this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`xai.connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        logger.info("xai.connect.open", { callId });
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Wire the long-lived listeners now that the socket is open.
    ws.on("message", (data) => this.handleMessage(data));
    ws.on("error", (err) => {
      logger.error("xai.ws.error", { callId, err });
      this.errorHandler?.(err);
    });
    ws.on("close", (code) => {
      logger.info("xai.ws.close", { callId, code });
      this.closed = true;
      this.closeHandler?.(code);
    });

    // Wait for the server to emit `conversation.created` — that's the cue
    // to push `session.update`.
    await this.conversationCreated.waitFor(timeoutMs).catch((err) => {
      throw new Error(`xai.conversation.created not received: ${err.message}`);
    });
  }

  async configureSession(payload: SessionUpdatePayload): Promise<void> {
    const { logger, callId } = this.opts;
    this.send({ type: "session.update", session: payload });
    logger.info("xai.session.update.sent", { callId });

    const timeoutMs = this.opts.sessionConfiguredTimeoutMs ?? DEFAULT_SESSION_CONFIG_TIMEOUT_MS;
    await this.sessionConfigured.waitFor(timeoutMs).catch((err) => {
      throw new Error(`xai.session.updated not received within ${timeoutMs}ms: ${err.message}`);
    });
    logger.info("xai.session.configured", { callId });
  }

  // Append caller audio. Drops silently if the WS isn't writable or the
  // session isn't configured yet — both happen briefly during call start.
  appendAudio(mulawBase64: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.sessionConfigured.state) return;
    this.send({ type: "input_audio_buffer.append", audio: mulawBase64 });
  }

  // Trigger the agent to speak immediately. Used for the initial greeting and
  // for the bridge-driven farewell — see injectFarewell below.
  triggerResponse(): void {
    this.send({ type: "response.create" });
  }

  // Send a typed conversation item (user/system message, function output).
  sendItem(item: ConversationItem): void {
    this.send({ type: "conversation.item.create", item });
  }

  // Send a function call result back to xAI and request the next response.
  // Matches the cookbook's function_call_output flow.
  sendFunctionResult(callId: string, output: string): void {
    this.sendItem({ type: "function_call_output", call_id: callId, output });
    this.triggerResponse();
  }

  // Inject a deterministic farewell. Pattern A from the spec:
  //   conversation.item.create with role=system + "Now say exactly: ..."
  //   followed by response.create.
  //
  // Why this pattern: xAI's protocol (per the cookbook) accepts
  // `conversation.item.create` with a `message` item carrying any role —
  // including `system`. Wrapping the farewell as a system directive
  // ("Now say exactly: ...") makes the LLM deliver the exact configured
  // text, not its own rephrasing. Pattern B (response.instructions override
  // on response.create) is NOT visible in the cookbook and not in the
  // OpenAI Realtime API surface for system-mid-conversation steering, so we
  // don't rely on it. Pattern C wasn't found.
  injectFarewell(farewellText: string): void {
    this.sendItem({
      type: "message",
      role: "system",
      content: [
        {
          type: "input_text",
          text: `Now say exactly the following sentence, then end the call. Do not paraphrase, do not add anything, do not call any tools: ${farewellText}`,
        },
      ],
    });
    this.triggerResponse();
  }

  onAudio(h: AudioHandler): void { this.audioHandler = h; }
  onSpeechStarted(h: SpeechStartedHandler): void { this.speechStartedHandler = h; }
  onResponseDone(h: ResponseDoneHandler): void { this.responseDoneHandler = h; }
  onFunctionCall(h: FunctionCallHandler): void { this.functionCallHandler = h; }
  onTranscript(h: TranscriptHandler): void { this.transcriptHandler = h; }
  onError(h: ErrorHandler): void { this.errorHandler = h; }
  onClose(h: CloseHandler): void { this.closeHandler = h; }

  async close(code: number = 1000): Promise<void> {
    if (!this.ws || this.closed) return;
    try {
      this.ws.close(code);
    } catch (err) {
      this.opts.logger.warn("xai.close.error", { callId: this.opts.callId, err });
    }
  }

  // --- internals ---

  private send(msg: XaiOutbound): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.opts.logger.warn("xai.send.dropped.not_open", { callId: this.opts.callId, type: msg.type });
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(data: WebSocket.RawData): void {
    let parsed: XaiInbound;
    try {
      parsed = JSON.parse(data.toString()) as XaiInbound;
    } catch (err) {
      this.opts.logger.warn("xai.message.parse_error", { callId: this.opts.callId, err });
      return;
    }

    // Log all event types except the high-volume audio delta.
    if (parsed.type !== "response.output_audio.delta") {
      this.opts.logger.debug("xai.event", { callId: this.opts.callId, type: parsed.type });
    }

    switch (parsed.type) {
      case "conversation.created":
        this.conversationCreated.set();
        return;
      case "session.updated":
        this.sessionConfigured.set();
        return;
      case "response.output_audio.delta":
        if (parsed.delta) this.audioHandler?.(parsed.delta);
        return;
      case "response.done":
        this.responseDoneHandler?.();
        return;
      case "input_audio_buffer.speech_started":
        this.speechStartedHandler?.();
        return;
      case "response.output_item.done":
        if (parsed.item?.type === "function_call") {
          const item = parsed.item;
          let args: Record<string, unknown> = {};
          try {
            args = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {};
          } catch (err) {
            this.opts.logger.warn("xai.function_call.arg_parse_error", {
              callId: this.opts.callId,
              name: item.name,
              rawArgs: item.arguments,
              err,
            });
          }
          this.functionCallHandler?.({
            name: item.name,
            callId: item.call_id,
            args,
            rawArgs: item.arguments,
          });
        }
        return;
      case "response.output_audio_transcript.delta":
        if (parsed.delta) this.transcriptHandler?.(parsed.delta, "agent");
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (parsed.transcript) this.transcriptHandler?.(parsed.transcript, "caller");
        return;
      case "error":
        this.opts.logger.error("xai.error_event", { callId: this.opts.callId, error: parsed.error });
        this.errorHandler?.(parsed.error ?? { message: "unknown xai error" });
        return;
      default:
        return;
    }
  }
}

function appendQuery(url: string, params: Record<string, string>): string {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  if (!qs) return url;
  return url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
}
