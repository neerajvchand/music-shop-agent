from __future__ import annotations

import logging
from datetime import datetime

from app.supabase_client import get_supabase

logger = logging.getLogger(__name__)


async def log_call(
    shop_id: str,
    twilio_call_sid: str | None,
    started_at: datetime,
    ended_at: datetime,
    transcript: str,
    caller_phone: str | None,
    outcome: str | None = None,
    error: str | None = None,
) -> None:
    """Insert a call record into the calls table."""
    duration_s = int((ended_at - started_at).total_seconds())

    if outcome is None:
        outcome = "completed" if transcript.strip() else "abandoned"

    # Simple intent extraction from transcript
    intents = _extract_intents(transcript)

    row = {
        "shop_id": shop_id,
        "twilio_call_sid": twilio_call_sid,
        "started_at": started_at.isoformat(),
        "ended_at": ended_at.isoformat(),
        "duration_s": duration_s,
        "caller_phone": caller_phone,
        "transcript": transcript or None,
        "outcome": outcome,
        "intents": intents,
        "error": error,
    }

    try:
        get_supabase().table("calls").insert(row).execute()
        logger.info(
            "Call logged: shop=%s sid=%s duration=%ds outcome=%s intents=%s",
            shop_id,
            twilio_call_sid,
            duration_s,
            outcome,
            intents,
        )
    except Exception as e:
        logger.error("Failed to log call: %s", e)


def _extract_intents(transcript: str) -> list[str]:
    """Simple keyword-based intent extraction."""
    if not transcript:
        return []
    t = transcript.lower()
    intents = []
    if any(w in t for w in ["book", "schedule", "appointment", "lesson"]):
        intents.append("booking")
    if any(w in t for w in ["cancel", "reschedule", "change"]):
        intents.append("modification")
    if any(w in t for w in ["price", "cost", "how much", "rate"]):
        intents.append("pricing")
    if any(w in t for w in ["hours", "open", "close", "when"]):
        intents.append("hours")
    if any(w in t for w in ["location", "address", "where", "parking"]):
        intents.append("location")
    if any(w in t for w in ["complaint", "bad", "terrible", "refund", "unhappy"]):
        intents.append("complaint")
    return intents
