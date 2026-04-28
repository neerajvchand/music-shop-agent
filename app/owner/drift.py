"""Drift detection: alert when booking rate drops or call quality degrades."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app.supabase_client import get_supabase

logger = logging.getLogger(__name__)

# Thresholds
BOOKING_RATE_DROP_PCT = 0.30  # 30% drop triggers alert
MIN_CALLS_FOR_ALERT = 10
SCORE_THRESHOLD = 0.70


async def check_drift(shop_id: str) -> list[dict[str, Any]]:
    """Check for drift alerts. Returns list of alert dicts."""
    alerts = []
    now = datetime.now(timezone.utc)
    this_week_start = now - timedelta(days=7)
    last_week_start = now - timedelta(days=14)

    sb = get_supabase()

    # Booking rate comparison
    this_week_calls = (
        sb.table("calls")
        .select("id", count="exact")
        .eq("shop_id", shop_id)
        .gte("started_at", this_week_start.isoformat())
        .execute()
    )
    this_week_bookings = (
        sb.table("bookings")
        .select("id", count="exact")
        .eq("shop_id", shop_id)
        .gte("created_at", this_week_start.isoformat())
        .eq("status", "confirmed")
        .execute()
    )
    last_week_calls = (
        sb.table("calls")
        .select("id", count="exact")
        .eq("shop_id", shop_id)
        .gte("started_at", last_week_start.isoformat())
        .lt("started_at", this_week_start.isoformat())
        .execute()
    )
    last_week_bookings = (
        sb.table("bookings")
        .select("id", count="exact")
        .eq("shop_id", shop_id)
        .gte("created_at", last_week_start.isoformat())
        .lt("created_at", this_week_start.isoformat())
        .eq("status", "confirmed")
        .execute()
    )

    tw_calls = this_week_calls.count or 0
    tw_bookings = this_week_bookings.count or 0
    lw_calls = last_week_calls.count or 0
    lw_bookings = last_week_bookings.count or 0

    tw_rate = tw_bookings / max(tw_calls, 1)
    lw_rate = lw_bookings / max(lw_calls, 1)

    if tw_calls >= MIN_CALLS_FOR_ALERT and lw_rate > 0:
        drop = (lw_rate - tw_rate) / lw_rate
        if drop >= BOOKING_RATE_DROP_PCT:
            alerts.append({
                "type": "booking_rate_drop",
                "severity": "warning" if drop < 0.5 else "critical",
                "message": f"Booking rate dropped {drop:.0%} this week ({tw_rate:.0%} vs {lw_rate:.0%} last week).",
                "context": {
                    "this_week_calls": tw_calls,
                    "this_week_bookings": tw_bookings,
                    "last_week_calls": lw_calls,
                    "last_week_bookings": lw_bookings,
                },
            })

    # Call score degradation
    recent_scores = (
        sb.table("call_scores")
        .select("overall_score")
        .eq("shop_id", shop_id)
        .gte("created_at", this_week_start.isoformat())
        .execute()
    )
    scores = [s["overall_score"] for s in (recent_scores.data or []) if s.get("overall_score")]
    if len(scores) >= MIN_CALLS_FOR_ALERT:
        avg_score = sum(scores) / len(scores)
        if avg_score < SCORE_THRESHOLD:
            alerts.append({
                "type": "call_quality_drop",
                "severity": "warning",
                "message": f"Average call quality score is {avg_score:.0%} (below {SCORE_THRESHOLD:.0%}).",
                "context": {"avg_score": avg_score, "samples": len(scores)},
            })

    return alerts
