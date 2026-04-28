"""Daily summary generation for shop owners."""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from app.supabase_client import get_supabase

logger = logging.getLogger(__name__)


async def generate_daily_summary(shop_id: str, summary_date: date | None = None) -> dict[str, Any]:
    """Aggregate call and booking data into a daily summary."""
    sb = get_supabase()
    summary_date = summary_date or (datetime.now(timezone.utc).date() - timedelta(days=1))
    day_start = datetime.combine(summary_date, datetime.min.time()).astimezone(timezone.utc)
    day_end = day_start + timedelta(days=1)

    # Calls
    calls_result = (
        sb.table("calls")
        .select("outcome, intents, transcript")
        .eq("shop_id", shop_id)
        .gte("started_at", day_start.isoformat())
        .lt("started_at", day_end.isoformat())
        .execute()
    )
    calls = calls_result.data or []
    calls_count = len(calls)
    missed = sum(1 for c in calls if c.get("outcome") == "abandoned")

    # Bookings
    bookings_result = (
        sb.table("bookings")
        .select("service, customer_name, scheduled_at")
        .eq("shop_id", shop_id)
        .gte("created_at", day_start.isoformat())
        .lt("created_at", day_end.isoformat())
        .eq("status", "confirmed")
        .execute()
    )
    bookings = bookings_result.data or []
    bookings_count = len(bookings)

    # Top intents (from calls with non-empty intents)
    intents: dict[str, int] = {}
    for c in calls:
        for intent in c.get("intents", []) or []:
            intents[intent] = intents.get(intent, 0) + 1
    top_intents = sorted(intents.items(), key=lambda x: x[1], reverse=True)[:5]

    # Pending decisions
    decisions_result = (
        sb.table("owner_decisions")
        .select("id, decision_type, title")
        .eq("shop_id", shop_id)
        .eq("status", "pending")
        .execute()
    )
    decisions = decisions_result.data or []

    summary = {
        "shop_id": shop_id,
        "summary_date": str(summary_date),
        "calls_count": calls_count,
        "bookings_count": bookings_count,
        "missed_calls_count": missed,
        "top_intents_json": [i[0] for i in top_intents],
        "decisions_json": [{"id": d["id"], "type": d["decision_type"], "title": d["title"]} for d in decisions],
        "digest_text": _build_digest_text(calls_count, bookings_count, missed, top_intents, decisions),
    }

    # Upsert
    try:
        sb.table("daily_summaries").upsert(summary).execute()
    except Exception as e:
        logger.error("Failed to save daily summary: %s", e)

    return summary


def _build_digest_text(
    calls: int,
    bookings: int,
    missed: int,
    top_intents: list[tuple[str, int]],
    decisions: list[dict[str, Any]],
) -> str:
    parts = [f"{calls} calls, {bookings} booked, {missed} missed."]
    if top_intents:
        parts.append(f"Top asks: {', '.join(i[0] for i in top_intents[:3])}.")
    if decisions:
        parts.append(f"{len(decisions)} decision(s) pending.")
    return " ".join(parts)


async def get_daily_digest(shop_id: str, summary_date: date | None = None) -> dict[str, Any] | None:
    """Retrieve a generated daily summary."""
    sb = get_supabase()
    summary_date = summary_date or (datetime.now(timezone.utc).date() - timedelta(days=1))
    result = (
        sb.table("daily_summaries")
        .select("*")
        .eq("shop_id", shop_id)
        .eq("summary_date", str(summary_date))
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None
