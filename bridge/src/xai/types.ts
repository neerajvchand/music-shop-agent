// Subset of the xAI Voice Agent / OpenAI Realtime API event surface used by
// this bridge. The cookbook at xai-cookbook/telephony/xai/src/index.ts is the
// source of truth for event names and shapes — these definitions match what
// the cookbook actually receives and sends.

export type XaiOutbound =
  | { type: "session.update"; session: SessionUpdatePayload }
  | { type: "input_audio_buffer.append"; audio: string }
  | { type: "conversation.item.create"; item: ConversationItem }
  | { type: "response.create" };

export type ConversationItem =
  | { type: "message"; role: "user" | "system" | "assistant"; content: Array<{ type: "input_text"; text: string }> }
  | { type: "function_call_output"; call_id: string; output: string };

// Tool definitions are flat: { type:"function", name, description, parameters }
// — no `function:` wrapper. Verified against the cookbook.
export interface XaiTool {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface SessionUpdatePayload {
  instructions: string;
  voice: string;
  audio: {
    input: { format: { type: "audio/pcmu" } };
    output: { format: { type: "audio/pcmu" } };
  };
  turn_detection: {
    type: "server_vad";
    threshold?: number;
    silence_duration_ms?: number;
    prefix_padding_ms?: number;
  };
  tools?: XaiTool[];
}

// Inbound events the client cares about. Anything else is just logged at debug
// level and dropped.
export type XaiInbound =
  | { type: "conversation.created"; conversation?: { id: string } }
  | { type: "session.updated" }
  | { type: "response.created" }
  | { type: "response.output_audio.delta"; delta: string }
  | { type: "response.output_audio_transcript.delta"; delta?: string }
  | { type: "conversation.item.input_audio_transcription.completed"; transcript?: string }
  | { type: "response.output_item.added" }
  | { type: "response.output_item.done"; item?: ResponseOutputItem }
  | { type: "response.done" }
  | { type: "response.cancelled" }
  | { type: "input_audio_buffer.speech_started" }
  | { type: "conversation.item.added" }
  | { type: "error"; error?: { message?: string; type?: string } };

export type ResponseOutputItem =
  | { type: "function_call"; name: string; call_id: string; arguments: string }
  | { type: "message"; role?: string; content?: unknown };

export interface XaiFunctionCall {
  name: string;
  callId: string;
  // Parsed JSON; may be empty object if arguments string failed to parse.
  args: Record<string, unknown>;
  // Raw arguments string as received, for logging / debugging.
  rawArgs: string;
}
