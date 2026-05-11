import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../logger";

// Mirrors app/call_logger.py:log_call — same columns, same insert shape.
// Outcome defaults: "completed" if transcript non-empty, "abandoned" otherwise.

export interface CallRecord {
  shop_id: string;
  twilio_call_sid: string | null;
  started_at: Date;
  ended_at: Date;
  caller_phone: string | null;
  transcript: string;
  outcome?: string;
  error?: string | null;
}

const INTENT_KEYWORDS: Array<[string, string[]]> = [
  ["booking", ["book", "schedule", "appointment", "lesson"]],
  ["modification", ["cancel", "reschedule", "change"]],
  ["pricing", ["price", "cost", "how much", "rate"]],
  ["hours", ["hours", "open", "close", "when"]],
  ["location", ["location", "address", "where", "parking"]],
  ["complaint", ["complaint", "bad", "terrible", "refund", "unhappy"]],
];

function extractIntents(transcript: string): string[] {
  if (!transcript) return [];
  const t = transcript.toLowerCase();
  return INTENT_KEYWORDS.filter(([, kws]) => kws.some((kw) => t.includes(kw))).map(([n]) => n);
}

export async function logCall(
  sb: SupabaseClient,
  record: CallRecord,
  logger: Logger,
): Promise<void> {
  const durationS = Math.max(0, Math.floor((record.ended_at.getTime() - record.started_at.getTime()) / 1000));
  const outcome = record.outcome ?? (record.transcript.trim() ? "completed" : "abandoned");
  const intents = extractIntents(record.transcript);

  const row = {
    shop_id: record.shop_id,
    twilio_call_sid: record.twilio_call_sid,
    started_at: record.started_at.toISOString(),
    ended_at: record.ended_at.toISOString(),
    duration_s: durationS,
    caller_phone: record.caller_phone,
    transcript: record.transcript || null,
    outcome,
    intents,
    error: record.error ?? null,
  };

  const { error } = await sb.from("calls").insert(row);
  if (error) {
    logger.error("calls.insert.error", { err: error, shopId: record.shop_id });
    return;
  }
  logger.info("calls.logged", {
    shopId: record.shop_id,
    sid: record.twilio_call_sid,
    durationS,
    outcome,
    intents,
  });
}
