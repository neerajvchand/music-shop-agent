import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "../logger";

// Mirrors app/booking/persistence.py:save_draft — same table, same columns,
// same 10-minute expiry. Bridge upserts the draft whenever the LLM emits a
// partial slot capture (Phase 2 work — Phase 1 only writes on call end if
// there's an incomplete booking in flight).

export interface BookingDraftRow {
  shop_id: string;
  call_sid: string;
  caller_phone: string | null;
  vertical_slug: string;
  state: string;
  captured_slots_json: Record<string, unknown>;
  confirmed_slots_json: Record<string, unknown>;
}

const DRAFT_TTL_MS = 10 * 60 * 1000;

export async function saveDraft(
  sb: SupabaseClient,
  draft: BookingDraftRow,
  logger: Logger,
): Promise<void> {
  const row = {
    ...draft,
    expires_at: new Date(Date.now() + DRAFT_TTL_MS).toISOString(),
  };
  const { error } = await sb.from("booking_drafts").upsert(row);
  if (error) {
    logger.error("booking_drafts.upsert.error", {
      shopId: draft.shop_id,
      callSid: draft.call_sid,
      err: error,
    });
  }
}
