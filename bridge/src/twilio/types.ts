// Typed Twilio Media Streams event surface. Mirrors the cookbook's twilio.ts
// — the cookbook is the source of truth for what shapes Twilio actually
// sends. We only add the types we need.

export type TwilioStreamAction = ClearAction | SendAudioAction | SendMarkAction;

export interface ClearAction {
  event: "clear";
  streamSid: string;
}

export interface SendAudioAction {
  event: "media";
  streamSid: string;
  media: { payload: string };
}

export interface SendMarkAction {
  event: "mark";
  streamSid: string;
  mark: { name: string };
}

export type TwilioStreamMessage =
  | ConnectedEvent
  | StartEvent
  | MediaEvent
  | DTMFEvent
  | MarkEvent
  | StopEvent;

export interface ConnectedEvent {
  event: "connected";
  protocol: string;
  version: string;
}

export interface StartEvent {
  event: "start";
  sequenceNumber: number;
  start: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: Array<"inbound" | "outbound">;
    mediaFormat: {
      encoding: "audio/x-mulaw";
      sampleRate: number;
      channels: number;
    };
    customParameters: Record<string, unknown>;
  };
}

export interface MediaEvent {
  event: "media";
  sequenceNumber: number;
  media: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string;
  };
  streamSid: string;
}

export interface DTMFEvent {
  event: "dtmf";
  dtmf: { digit: string; track: string };
  sequenceNumber: number;
  streamSid: string;
}

export interface MarkEvent {
  event: "mark";
  mark: { name: string };
  sequenceNumber: number;
  streamSid: string;
}

export interface StopEvent {
  event: "stop";
  sequenceNumber: number;
  streamSid: string;
  stop: { accountSid: string; callSid: string };
}

export type TwilioStreamMessageType = TwilioStreamMessage["event"];
