"""Regression tests for app.booking.validation.validate_book_appointment_args.

Each error code in the contract has a dedicated test. One happy-path test
proves the validator returns a timezone-aware datetime when inputs are good.
One timezone-fallback test asserts the warning behavior.
"""

from datetime import datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pytest

from app.booking.validation import (
    DEFAULT_TIMEZONE,
    MAX_FUTURE_DAYS,
    validate_book_appointment_args,
)


class _FakeShop:
    def __init__(self, **kw):
        defaults = dict(
            timezone="America/Los_Angeles",
            business_hours_json={
                "monday": None,
                "tuesday":  {"open": "10:00", "close": "19:00"},
                "wednesday":{"open": "10:00", "close": "19:00"},
                "thursday": {"open": "10:00", "close": "19:00"},
                "friday":   {"open": "10:00", "close": "19:00"},
                "saturday": {"open": "10:00", "close": "19:00"},
                "sunday": None,
            },
            services_json=[
                {"slug": "tabla_lesson", "duration_minutes": 30, "active": True},
                {"slug": "tabla_lesson_60", "duration_minutes": 60, "active": True},
            ],
        )
        defaults.update(kw)
        for k, v in defaults.items():
            setattr(self, k, v)


def _future_iso(days: int = 7, hour: int = 14, weekday: int | None = None) -> tuple[str, str]:
    """Return (date_str, time_str) for an open Tuesday-Saturday slot."""
    target = datetime.now(tz=ZoneInfo("America/Los_Angeles")) + timedelta(days=days)
    if weekday is not None:
        # Advance until we hit the requested weekday (0=Mon).
        while target.weekday() != weekday:
            target += timedelta(days=1)
    elif target.weekday() in (0, 6):  # avoid Mon/Sun (closed in fixture)
        target += timedelta(days=1)
        if target.weekday() == 6:
            target += timedelta(days=1)
    return target.date().isoformat(), f"{hour:02d}:00"


# -------- happy path --------

def test_happy_path_returns_aware_datetime():
    date_str, time_str = _future_iso()
    args = {
        "service": "tabla_lesson",
        "date": date_str,
        "time": time_str,
        "customer_phone": "+15555550000",
    }
    scheduled, error = validate_book_appointment_args(args, _FakeShop())
    assert error is None
    assert isinstance(scheduled, datetime)
    assert scheduled.tzinfo is not None


# -------- error code coverage --------

def test_missing_service():
    date_str, time_str = _future_iso()
    args = {"service": "  ", "date": date_str, "time": time_str, "customer_phone": "+15555550000"}
    _, error = validate_book_appointment_args(args, _FakeShop())
    assert error and error["error"] == "missing_service"


def test_missing_phone_when_neither_arg_nor_caller():
    date_str, time_str = _future_iso()
    args = {"service": "tabla_lesson", "date": date_str, "time": time_str}
    _, error = validate_book_appointment_args(args, _FakeShop(), caller_phone=None)
    assert error and error["error"] == "missing_phone"


def test_caller_phone_satisfies_missing_customer_phone():
    """If customer_phone is empty but Twilio gave us caller_phone, accept it."""
    date_str, time_str = _future_iso()
    args = {"service": "tabla_lesson", "date": date_str, "time": time_str, "customer_phone": ""}
    _, error = validate_book_appointment_args(args, _FakeShop(), caller_phone="+15555551212")
    assert error is None


def test_missing_date():
    args = {"service": "tabla_lesson", "date": "", "time": "14:00", "customer_phone": "+15555550000"}
    _, error = validate_book_appointment_args(args, _FakeShop())
    assert error and error["error"] == "missing_date"


def test_missing_time():
    date_str, _ = _future_iso()
    args = {"service": "tabla_lesson", "date": date_str, "time": "  ", "customer_phone": "+15555550000"}
    _, error = validate_book_appointment_args(args, _FakeShop())
    assert error and error["error"] == "missing_time"


def test_invalid_date_format():
    args = {
        "service": "tabla_lesson",
        "date": "next Tuesday",
        "time": "14:00",
        "customer_phone": "+15555550000",
    }
    _, error = validate_book_appointment_args(args, _FakeShop())
    assert error and error["error"] == "invalid_date_format"


def test_date_in_past():
    yesterday = (datetime.now(tz=ZoneInfo("America/Los_Angeles")) - timedelta(days=1)).date().isoformat()
    args = {
        "service": "tabla_lesson",
        "date": yesterday,
        "time": "14:00",
        "customer_phone": "+15555550000",
    }
    _, error = validate_book_appointment_args(args, _FakeShop())
    assert error and error["error"] == "date_in_past"


def test_date_too_far_future():
    far = (datetime.now(tz=ZoneInfo("America/Los_Angeles")) + timedelta(days=MAX_FUTURE_DAYS + 5)).date().isoformat()
    args = {
        "service": "tabla_lesson",
        "date": far,
        "time": "14:00",
        "customer_phone": "+15555550000",
    }
    _, error = validate_book_appointment_args(args, _FakeShop())
    assert error and error["error"] == "date_too_far_future"


def test_outside_business_hours_closed_day():
    # Pick a Sunday — closed in the fixture.
    sunday = datetime.now(tz=ZoneInfo("America/Los_Angeles")) + timedelta(days=1)
    while sunday.weekday() != 6:
        sunday += timedelta(days=1)
    args = {
        "service": "tabla_lesson",
        "date": sunday.date().isoformat(),
        "time": "14:00",
        "customer_phone": "+15555550000",
    }
    _, error = validate_book_appointment_args(args, _FakeShop())
    assert error and error["error"] == "outside_business_hours"
    # Message should reference real closed days from JSON, not a hardcode.
    assert "Sundays" in error["message"]
    assert "Mondays" in error["message"]


def test_outside_business_hours_late_evening():
    # Saturday at 22:00 — open Tue–Sat 10–19.
    date_str, _ = _future_iso(weekday=5)  # Saturday
    args = {
        "service": "tabla_lesson",
        "date": date_str,
        "time": "22:00",
        "customer_phone": "+15555550000",
    }
    _, error = validate_book_appointment_args(args, _FakeShop())
    assert error and error["error"] == "outside_business_hours"


# -------- timezone fallback --------

def test_timezone_fallback_when_shop_timezone_missing(caplog):
    date_str, time_str = _future_iso()
    args = {
        "service": "tabla_lesson",
        "date": date_str,
        "time": time_str,
        "customer_phone": "+15555550000",
    }
    shop = _FakeShop(timezone=None)
    with caplog.at_level("WARNING", logger="app.booking.validation"):
        scheduled, error = validate_book_appointment_args(args, shop)
    assert error is None
    assert scheduled.tzinfo == ZoneInfo(DEFAULT_TIMEZONE)
    assert any("falling back" in rec.message for rec in caplog.records), \
        [r.message for r in caplog.records]


def test_timezone_fallback_when_shop_timezone_invalid(caplog):
    date_str, time_str = _future_iso()
    args = {
        "service": "tabla_lesson",
        "date": date_str,
        "time": time_str,
        "customer_phone": "+15555550000",
    }
    shop = _FakeShop(timezone="Not/A_Real_Zone")
    with caplog.at_level("WARNING", logger="app.booking.validation"):
        scheduled, error = validate_book_appointment_args(args, shop)
    assert error is None
    assert scheduled.tzinfo == ZoneInfo(DEFAULT_TIMEZONE)
    assert any("Not/A_Real_Zone" in rec.message for rec in caplog.records)


# -------- duration-aware outside_business_hours --------

def _next_open_day(weekday: int = 1) -> datetime:
    """Return a future datetime on the requested weekday (Tue=1 by default)."""
    target = datetime.now(tz=ZoneInfo("America/Los_Angeles")) + timedelta(days=1)
    while target.weekday() != weekday:
        target += timedelta(days=1)
    return target


def test_duration_aware_60min_at_18_00_passes():
    """60-min appointment at 18:00 with close 19:00 fits exactly."""
    target = _next_open_day()
    args = {
        "service": "tabla_lesson_60",
        "date": target.date().isoformat(),
        "time": "18:00",
        "customer_phone": "+15555550000",
    }
    scheduled, error = validate_book_appointment_args(args, _FakeShop())
    assert error is None, error
    assert scheduled is not None


def test_duration_aware_boundary_end_equals_close():
    """End_time == close_time is permitted (not strictly greater than)."""
    target = _next_open_day()
    args = {
        "service": "tabla_lesson_60",
        "date": target.date().isoformat(),
        "time": "18:00",
        "customer_phone": "+15555550000",
    }
    # Tighten close to exactly match end. 18:00 + 60 = 19:00 = close.
    scheduled, error = validate_book_appointment_args(args, _FakeShop())
    assert error is None


def test_duration_aware_post_close_fails_with_duration_message():
    """60-min appointment at 18:30 with close 19:00 → outside_business_hours."""
    target = _next_open_day()
    args = {
        "service": "tabla_lesson_60",
        "date": target.date().isoformat(),
        "time": "18:30",
        "customer_phone": "+15555550000",
    }
    _, error = validate_book_appointment_args(args, _FakeShop())
    assert error is not None
    assert error["error"] == "outside_business_hours"
    assert "60-minute" in error["message"]
    assert "7pm" in error["message"]
    # Should suggest an earlier start.
    assert "earlier" in error["message"].lower() or "another day" in error["message"].lower()


def test_service_slug_not_in_catalog_returns_missing_service():
    """LLM hallucinated a slug not present in services_json."""
    target = _next_open_day()
    args = {
        "service": "violin_lesson",  # not in catalog
        "date": target.date().isoformat(),
        "time": "14:00",
        "customer_phone": "+15555550000",
    }
    _, error = validate_book_appointment_args(args, _FakeShop())
    assert error is not None
    assert error["error"] == "missing_service"
    assert "couldn't find" in error["message"] or "catalog" in error["message"]


def test_empty_services_json_falls_back_to_default_duration():
    """Shop with no catalog still books, using DEFAULT_DURATION_MIN."""
    target = _next_open_day()
    args = {
        "service": "any_service",
        "date": target.date().isoformat(),
        "time": "14:00",
        "customer_phone": "+15555550000",
    }
    shop = _FakeShop(services_json=[])
    scheduled, error = validate_book_appointment_args(args, shop)
    assert error is None
    assert scheduled is not None
