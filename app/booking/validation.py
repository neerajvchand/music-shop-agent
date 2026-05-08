"""Pure input validation for the book_appointment tool.

DUAL-VALIDATOR PATTERN: This validator is duplicated between Python (this file)
and TypeScript (dashboard/lib/booking/validation.ts) for defense-in-depth. If
you modify one, modify the other to keep error codes and logic in sync. Drift
between them produces inconsistent caller experiences depending on which entry
point caught the error.

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
DEFAULT_DURATION_MIN = 60

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


def _format_h12(hour: int, minute: int = 0) -> str:
    """Format an integer hour/minute as a natural 12-hour string."""
    suffix = "am" if hour < 12 else "pm"
    h12 = hour % 12 or 12
    if minute == 0:
        return f"{h12}{suffix}"
    return f"{h12}:{minute:02d}{suffix}"


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


def _find_service(shop: Any, service_slug: str) -> dict | None:
    """Look up a service by slug or id in shop.services_json."""
    services = getattr(shop, "services_json", None) or []
    if not isinstance(services, list):
        return None
    for s in services:
        if not isinstance(s, dict):
            continue
        if s.get("slug") == service_slug or s.get("id") == service_slug:
            return s
    return None


def _service_duration_minutes(svc: dict) -> int:
    """Read duration in minutes from a service dict, supporting both keys."""
    for key in ("duration_minutes", "duration_min"):
        v = svc.get(key)
        if isinstance(v, int) and v > 0:
            return v
    return DEFAULT_DURATION_MIN


def _within_business_hours_with_duration(
    business_hours: dict, scheduled: datetime, duration_minutes: int,
) -> tuple[bool, dict | None]:
    """True if `[scheduled, scheduled+duration]` fits inside the day's open hours.

    Returns (ok, hours_entry) — hours_entry is the day's open/close dict on
    success so the caller can format a duration-aware error message.
    """
    if not isinstance(business_hours, dict) or not business_hours:
        return True, None

    entry = _hours_for_day(business_hours, scheduled)
    if entry is None:
        return False, None

    try:
        open_h, open_m = (int(p) for p in entry["open"].split(":"))
        close_h, close_m = (int(p) for p in entry["close"].split(":"))
    except (ValueError, KeyError, AttributeError):
        return True, entry

    start_minute = scheduled.hour * 60 + scheduled.minute
    end_minute = start_minute + duration_minutes
    open_minute = open_h * 60 + open_m
    close_minute = close_h * 60 + close_m

    if start_minute < open_minute:
        return False, entry
    if end_minute > close_minute:
        return False, entry
    return True, entry


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

    customer_phone = args.get("customer_phone") or args.get("caller_phone")
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

    # Resolve the service from the catalog. If services_json is configured and
    # the LLM made up a slug, surface that as missing_service so it can ask the
    # caller to clarify. If services_json is empty, fall back to the default
    # duration so misconfigured shops still book.
    services = getattr(shop, "services_json", None) or []
    duration_minutes = DEFAULT_DURATION_MIN
    if isinstance(services, list) and services:
        svc = _find_service(shop, str(service))
        if svc is None:
            return None, {
                "error": "missing_service",
                "message": "I couldn't find that service in our catalog — could you confirm what you're looking for?",
            }
        duration_minutes = _service_duration_minutes(svc)

    business_hours = getattr(shop, "business_hours_json", None) or {}
    ok, hours_entry = _within_business_hours_with_duration(
        business_hours, scheduled, duration_minutes,
    )
    if not ok:
        # Closed day vs. duration-overflow are different shapes of message.
        if hours_entry is None:
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
        else:
            try:
                close_h, close_m = (int(p) for p in hours_entry["close"].split(":"))
                close_str = _format_h12(close_h, close_m)
            except Exception:
                close_str = "close"
            start_str = _format_h12(scheduled.hour, scheduled.minute)
            message = (
                f"A {duration_minutes}-minute appointment at {start_str} would run past our "
                f"{close_str} close. Want to start earlier, or pick another day?"
            )
        return None, {"error": "outside_business_hours", "message": message}

    return scheduled, None
