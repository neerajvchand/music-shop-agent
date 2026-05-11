import type { SessionUpdatePayload, XaiTool } from "./types";

// Sensible defaults for a Twilio-fronted phone call. PCMU 8kHz both directions
// (Twilio Media Streams' native format — no transcoding needed).
//
// turn_detection thresholds are tuned conservatively:
//   - threshold 0.85 favours fewer false starts (avoids the bot interrupting
//     mid-thought when the caller pauses naturally).
//   - silence_duration_ms 800 — caller can pause briefly without triggering
//     end-of-turn.
//   - prefix_padding_ms 333 — keeps the first ~330ms of the caller's
//     utterance even if VAD onset is delayed.
//
// If xAI rejects any of these as unknown fields it will surface as an `error`
// event on the WS at session.update time; observable, not fatal-at-connect.

export interface BuildSessionConfigParams {
  instructions: string;
  voice: string;
  tools?: XaiTool[];
}

export function buildSessionConfig(params: BuildSessionConfigParams): SessionUpdatePayload {
  const payload: SessionUpdatePayload = {
    instructions: params.instructions,
    voice: params.voice,
    audio: {
      input: { format: { type: "audio/pcmu" } },
      output: { format: { type: "audio/pcmu" } },
    },
    turn_detection: {
      type: "server_vad",
      threshold: 0.85,
      silence_duration_ms: 800,
      prefix_padding_ms: 333,
    },
  };
  if (params.tools && params.tools.length > 0) {
    payload.tools = params.tools;
  }
  return payload;
}
