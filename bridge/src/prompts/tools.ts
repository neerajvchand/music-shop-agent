import type { XaiTool } from "../xai/types";

// Tool definitions wired by the bridge. Three tools: end_call (signal),
// check_availability and create_booking (HMAC'd round-trips to the Vercel
// agent API).
//
// Phase 1 hardcodes these — the Python bridge parses tool defs from the
// `tools` prompt module's content. Phase 2 may move to parsing if the
// schema needs to evolve per-shop. For now the schema matches what the
// Vercel agent routes already accept.

export function buildToolDefinitions(): XaiTool[] {
  return [
    {
      type: "function",
      name: "end_call",
      description:
        "Signal that the caller is done and the call should end. After calling this, the bridge will speak the configured farewell automatically. Do NOT add a goodbye message in the same turn — let the bridge handle it.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Short reason for ending the call (e.g. 'caller_done', 'caller_will_drop_in').",
          },
        },
        required: ["reason"],
      },
    },
    {
      type: "function",
      name: "check_availability",
      description:
        "Check whether a given date has available time slots for a service. Returns a list of suggested times.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Target date in YYYY-MM-DD format.",
          },
          durationMinutes: {
            type: "number",
            description: "Service duration in minutes.",
          },
          timezone: {
            type: "string",
            description: "IANA timezone (e.g. 'America/Los_Angeles'). Optional; defaults to shop timezone.",
          },
        },
        required: ["date", "durationMinutes"],
      },
    },
    {
      type: "function",
      name: "create_booking",
      description:
        "Create a confirmed booking. Use the EXACT service slug shown in brackets in the services list. Returns a booking confirmation or a structured error the agent should read aloud.",
      parameters: {
        type: "object",
        properties: {
          customerName: { type: "string", description: "Customer's full name." },
          customerPhone: { type: "string", description: "Customer's phone number." },
          service: { type: "string", description: "Service slug (verbatim from the services list)." },
          startTime: { type: "string", description: "ISO 8601 start datetime with timezone offset." },
          durationMinutes: { type: "number", description: "Duration in minutes." },
          notes: { type: "string", description: "Optional notes." },
        },
        required: ["customerName", "customerPhone", "service", "startTime", "durationMinutes"],
      },
    },
  ];
}
