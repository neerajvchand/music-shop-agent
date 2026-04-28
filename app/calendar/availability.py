"""Check calendar availability and propose free slots."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app.calendar.client import get_calendar_client
from app.shops import Shop

logger = logging.getLogger(__name__)

# Default slot duration in minutes
DEFAULT_SLOT_DURATION = 60
# How far ahead to look for availability
AVAILABILITY_WINDOW_DAYS = 14
# Business hours (can be overridden per shop)
DEFAULT_OPEN_HOUR = 9
DEFAULT_CLOSE_HOUR = 18


async def check_availability(
    shop: Shop,
    proposed_start: datetime,
    duration_min: int = DEFAULT_SLOT_DURATION,
) -> tuple[bool, list[dict[str, Any]]]:
    """
    Check if a proposed slot is free.
    Returns (is_free, conflicting_busy_intervals).
    """
    client = await get_calendar_client(shop.id)
    if not client:
        # No calendar connected — assume free
        return True, []

    calendar_id = shop.gcal_calendar_id or "primary"
    time_min = proposed_start
    time_max = proposed_start + timedelta(minutes=duration_min)

    try:
        busy = await client.free_busy(time_min, time_max, calendar_id)
        conflicts = [b for b in busy if _overlaps(b, time_min, time_max)]
        return len(conflicts) == 0, conflicts
    except Exception as e:
        logger.error("Availability check failed for shop %s: %s", shop.slug, e)
        # Fail open: assume free to avoid blocking bookings on transient errors
        return True, []


def _overlaps(busy: dict[str, str], start: datetime, end: datetime) -> bool:
    b_start = datetime.fromisoformat(busy["start"].replace("Z", "+00:00"))
    b_end = datetime.fromisoformat(busy["end"].replace("Z", "+00:00"))
    return b_start < end and b_end > start


async def get_free_slots(
    shop: Shop,
    from_date: datetime | None = None,
    days: int = AVAILABILITY_WINDOW_DAYS,
    duration_min: int = DEFAULT_SLOT_DURATION,
    max_slots: int = 5,
) -> list[datetime]:
    """
    Return up to `max_slots` free slot start times.
    Simple implementation: scan business hours day by day.
    """
    client = await get_calendar_client(shop.id)
    if not client:
        # No calendar — return generic slots
        return _generic_slots(from_date or datetime.now(timezone.utc), days, duration_min, max_slots)

    calendar_id = shop.gcal_calendar_id or "primary"
    from_date = from_date or datetime.now(timezone.utc)
    time_min = from_date
    time_max = from_date + timedelta(days=days)

    try:
        busy = await client.free_busy(time_min, time_max, calendar_id)
    except Exception as e:
        logger.error("free_busy query failed for shop %s: %s", shop.slug, e)
        return _generic_slots(from_date, days, duration_min, max_slots)

    # Parse business hours from shop config
    open_hour, close_hour = _parse_business_hours(shop)

    slots: list[datetime] = []
    current_day = from_date.replace(hour=0, minute=0, second=0, microsecond=0)
    if from_date.hour >= close_hour:
        current_day += timedelta(days=1)

    while len(slots) < max_slots and current_day < time_max:
        day_start = current_day.replace(hour=open_hour, minute=0)
        day_end = current_day.replace(hour=close_hour, minute=0)

        candidate = day_start
        while candidate + timedelta(minutes=duration_min) <= day_end and len(slots) < max_slots:
            candidate_end = candidate + timedelta(minutes=duration_min)
            if not any(_overlaps(b, candidate, candidate_end) for b in busy):
                slots.append(candidate)
            candidate += timedelta(minutes=duration_min)

        current_day += timedelta(days=1)

    return slots


def _generic_slots(
    from_date: datetime,
    days: int,
    duration_min: int,
    max_slots: int,
) -> list[datetime]:
    slots = []
    current = from_date.replace(hour=10, minute=0, second=0, microsecond=0)
    if current < from_date:
        current += timedelta(days=1)
    while len(slots) < max_slots and (current - from_date).days < days:
        for hour in [10, 12, 14, 16]:
            candidate = current.replace(hour=hour)
            if candidate > from_date:
                slots.append(candidate)
                if len(slots) >= max_slots:
                    break
        current += timedelta(days=1)
    return slots


def _parse_business_hours(shop: Shop) -> tuple[int, int]:
    """Extract open/close hour from shop business_hours_json."""
    try:
        bh = shop.business_hours_json
        if isinstance(bh, str):
            import json
            bh = json.loads(bh)
        # Simple: use today's hours or default
        default = bh.get("default", {}) if isinstance(bh, dict) else {}
        open_str = default.get("open", "09:00")
        close_str = default.get("close", "18:00")
        open_hour = int(open_str.split(":")[0])
        close_hour = int(close_str.split(":")[0])
        return open_hour, close_hour
    except Exception:
        return DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR
