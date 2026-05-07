"""Pure input validation for the book_appointment tool.

The agent's `book_appointment` tool used to raise on bad input; the bridge
caught the exception and returned an unstructured error string. The LLM had
no way to recover.

This module returns structured `{error: <code>, message: <text>}` dicts so
the LLM can choose what to ask the caller next. All checks are pure — no DB
calls, no side effects beyond a single warning when the shop's timezone is
malformed.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

logger = logging.getLogger(__name__)

DEFAULT_TIMEZONE = "America/Los_Angeles"
MAX_FUTURE_DAYS = 180

_DAY_INDEX_TO_KEY = [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]


def _missing(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str) and not value.strip():
        return True
    return False


def _resolve_zone(shop: Any) -> ZoneInfo:
    tz_name = getattr(shop, "timezone", None)
    if tz_name:
        try:
            return ZoneInfo(tz_name)
        except (ZoneInfoNotFoundError, ValueError, TypeError) as e:
            logger.warning(
                "Shop timezone %r is invalid (%s); falling back to %s",
                tz_name, e, DEFAULT_TIMEZONE,
            )
    else:
        logger.warning(
            "Shop timezone is missing; falling back to %s", DEFAULT_TIMEZONE,
        )
    return ZoneInfo(DEFAULT_TIMEZONE)


def _format_closed_days(business_hours: dict) -> str:
    closed = []
    for key in _DAY_INDEX_TO_KEY:
        entry = business_hours.get(key)
        if entry is None:
            closed.append(f"{key.capitalize()}s")
    if not closed:
        return ""
    if len(closed) == 1:
        return closed[0]
    if len(closed) == 2:
        return f"{closed[0]} and {closed[1]}"
    return ", ".join(closed[:-1]) + f", and {closed[-1]}"


def _open_days_phrase(business_hours: dict) -> str:
    open_days = [
        key.capitalize()
        for key in _DAY_INDEX_TO_KEY
        if isinstance(business_hours.get(key), dict)
    ]
    if not open_days:
        return ""
    if len(open_days) == 1:
        return open_days[0]
    if len(open_days) == 2:
        return f"{open_days[0]} or {open_days[1]}"
    return ", ".join(open_days[:-1]) + f", or {open_days[-1]}"


def _hours_for_day(business_hours: dict, scheduled: datetime) -> dict | None:
    key = _DAY_INDEX_TO_KEY[scheduled.weekday()]
    entry = business_hours.get(key)
    if isinstance(entry, dict) and "open" in entry and "close" in entry:
        return entry
    return None


def _within_business_hours(business_hours: dict, scheduled: datetime) -> bool:
    """True if `scheduled` (timezone-aware) falls inside the shop's open hours."""
    if not isinstance(business_hours, dict) or not business_hours:
        return True

    entry = _hours_for_day(business_hours, scheduled)
    if entry is None:
        return False

    try:
        open_h, open_m = (int(p) for p in entry["open"].split(":"))
        close_h, close_m = (int(p) for p in entry["close"].split(":"))
    except (ValueError, KeyError, AttributeError):
        return True

    minute_of_day = scheduled.hour * 60 + scheduled.minute
    return (open_h * 60 + open_m) <= minute_of_day <= (close_h * 60 + close_m)


def validate_book_appointment_args(
    args: dict,
    shop: Any,
    caller_phone: str | None = None,
) -> tuple[datetime | None, dict | None]:
    """Validate the agent's book_appointment call.

    Returns (scheduled_at, None) on success or (None, error_dict) on failure.
    error_dict shape: {"error": <code>, "message": <natural-language for LLM>}.
    """
    service = args.get("service")
    if _missing(service):
        return None, {
            "error": "missing_service",
            "message": "I need to know which service you'd like to book — could you confirm what you're looking for?",
        }

    customer_phone = args.get("customer_phone")
    if _missing(customer_phone) and _missing(caller_phone):
        return None, {
            "error": "missing_phone",
            "message": "Could you share a phone number we can reach you at?",
        }

    date_str = args.get("date")
    if _missing(date_str):
        return None, {
            "error": "missing_date",
            "message": "I need a confirmed date before I can book. What day works for you?",
        }

    time_str = args.get("time")
    if _missing(time_str):
        return None, {
            "error": "missing_time",
            "message": "What time would you like to come in?",
        }

    try:
        naive = datetime.fromisoformat(f"{str(date_str).strip()}T{str(time_str).strip()}")
    except (ValueError, TypeError):
        return None, {
            "error": "invalid_date_format",
            "message": "I had trouble parsing that date — could you say it again, like 'Tuesday June 4th'?",
        }

    zone = _resolve_zone(shop)
    scheduled = naive.replace(tzinfo=zone)
    now = datetime.now(tz=zone)

    if scheduled < now:
        return None, {
            "error": "date_in_past",
            "message": "That date has already passed. Want to pick a future day?",
        }

    if scheduled > now + timedelta(days=MAX_FUTURE_DAYS):
        return None, {
            "error": "date_too_far_future",
            "message": "That's quite far out — could you confirm the date you meant?",
        }

    business_hours = getattr(shop, "business_hours_json", None) or {}
    if not _within_business_hours(business_hours, scheduled):
        closed_phrase = _format_closed_days(business_hours)
        open_phrase = _open_days_phrase(business_hours)
        if closed_phrase and open_phrase:
            message = f"We're closed {closed_phrase}. Would {open_phrase} work better?"
        elif closed_phrase:
            message = f"We're closed {closed_phrase}. Could you pick another day?"
        elif open_phrase:
            message = f"That's outside our hours. We're open {open_phrase} — what would work?"
        else:
            message = "That's outside our hours. Could you pick another time?"
        return None, {"error": "outside_business_hours", "message": message}

    return scheduled, None
