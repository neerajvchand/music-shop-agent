"""Persist and resume booking drafts across call drops."""

from __future__ import annotations

import json
import logging
from typing import Any

from app.booking.state import BookingDraft, SlotDefinition
from app.supabase_client import get_supabase

logger = logging.getLogger(__name__)


async def load_draft(shop_id: str, call_sid: str) -> BookingDraft | None:
    """Load an existing non-expired draft for this call_sid."""
    sb = get_supabase()
    result = (
        sb.table("booking_drafts")
        .select("*")
        .eq("shop_id", shop_id)
        .eq("call_sid", call_sid)
        .gt("expires_at", "now()")
        .limit(1)
        .execute()
    )
    if not result.data:
        return None

    row = result.data[0]
    slots_data = row.get("captured_slots_json", {})
    confirmed = row.get("confirmed_slots_json", {})

    # Reconstruct slot definitions from vertical
    from app.booking.slots import get_slots_for_vertical
    vertical = row["vertical_slug"]
    slots_raw = get_slots_for_vertical(vertical)
    slots = [
        SlotDefinition(
            name=s["name"],
            required=s.get("required", True),
            type=s.get("type", "text"),
            options=s.get("options", []),
            min_len=s.get("min_len", 1),
        )
        for s in slots_raw
    ]

    draft = BookingDraft(
        shop_id=shop_id,
        call_sid=call_sid,
        caller_phone=row.get("caller_phone"),
        vertical_slug=vertical,
        slots=slots,
        captured=slots_data if isinstance(slots_data, dict) else json.loads(slots_data),
        confirmed=confirmed if isinstance(confirmed, dict) else json.loads(confirmed),
        state=row.get("state", "slot_capture"),
    )
    return draft


async def save_draft(draft: BookingDraft) -> None:
    """Upsert a booking draft."""
    sb = get_supabase()
    row = {
        "shop_id": draft.shop_id,
        "call_sid": draft.call_sid,
        "caller_phone": draft.caller_phone,
        "vertical_slug": draft.vertical_slug,
        "state": draft.state,
        "captured_slots_json": draft.captured,
        "confirmed_slots_json": draft.confirmed,
        "expires_at": "now() + interval '10 minutes'",
    }
    try:
        # Try upsert
        sb.table("booking_drafts").upsert(row).execute()
    except Exception as e:
        logger.error("Failed to save draft: %s", e)


async def expire_drafts() -> None:
    """Clean up expired drafts. Called by background task."""
    sb = get_supabase()
    try:
        sb.table("booking_drafts").delete().lt("expires_at", "now()").execute()
    except Exception as e:
        logger.warning("Failed to expire drafts: %s", e)
