"""Atomic booking: check → reserve → confirm → write → commit."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from app.calendar.availability import check_availability
from app.calendar.client import get_calendar_client
from app.shops import Shop
from app.supabase_client import get_supabase

logger = logging.getLogger(__name__)

RESERVE_TTL_SECONDS = 30


async def atomic_book(
    shop: Shop,
    service: str,
    start: datetime,
    customer_name: str,
    customer_phone: str,
    duration_min: int = 60,
    notes: str = "",
    extra_slots: dict[str, Any] | None = None,
    test_mode: bool = False,
) -> dict[str, Any]:
    """
    Atomic booking workflow:
      1. Check calendar availability
      2. Reserve slot in local DB (30s TTL)
      3. (Caller confirms verbally — happens outside this function)
      4. Write to Google Calendar
      5. Commit booking in local DB

    Returns booking dict or raises BookingConflictError.
    """
    # 1. Check availability
    is_free, conflicts = await check_availability(shop, start, duration_min)
    if not is_free:
        raise BookingConflictError(
            f"Slot conflict: {conflicts}"
        )

    # 2. Reserve in local DB
    end = start + timedelta(minutes=duration_min)
    sb = get_supabase()
    reserve_row = {
        "shop_id": shop.id,
        "service": service,
        "scheduled_at": start.isoformat(),
        "duration_min": duration_min,
        "timezone": shop.timezone,
        "customer_name": customer_name,
        "customer_phone": customer_phone,
        "notes": notes,
        "extra_slots_json": extra_slots or {},
        "status": "reserved",
    }
    reserve_result = sb.table("bookings").insert(reserve_row).execute()
    booking_id = reserve_result.data[0]["id"]
    logger.info("Reserved booking %s for shop %s", booking_id, shop.slug)

    if test_mode:
        # In test mode, skip calendar write but mark as confirmed
        sb.table("bookings").update({"status": "confirmed"}).eq("id", booking_id).execute()
        return reserve_result.data[0]

    # 4. Write to Google Calendar
    client = await get_calendar_client(shop.id)
    gcal_event_id = None
    if client:
        calendar_id = shop.gcal_calendar_id or "primary"
        try:
            event = await client.create_event(
                calendar_id=calendar_id,
                summary=f"{shop.name} — {service}",
                start=start,
                end=end,
                description=f"Customer: {customer_name}\nPhone: {customer_phone}\nNotes: {notes}",
                timezone=shop.timezone,
            )
            gcal_event_id = event.get("id") if event else None
        except Exception as e:
            logger.error("Google Calendar write failed for booking %s: %s", booking_id, e)
            # Rollback: delete reserved booking
            sb.table("bookings").delete().eq("id", booking_id).execute()
            raise CalendarWriteError(f"Failed to write to calendar: {e}") from e

    # 5. Commit
    update = {
        "status": "confirmed",
        "gcal_event_id": gcal_event_id,
    }
    sb.table("bookings").update(update).eq("id", booking_id).execute()
    logger.info("Booking %s confirmed (gcal_event_id=%s)", booking_id, gcal_event_id)

    return {**reserve_result.data[0], **update}


class BookingConflictError(Exception):
    """Raised when the requested slot conflicts with an existing booking."""
    pass


class CalendarWriteError(Exception):
    """Raised when Google Calendar write fails after reservation."""
    pass
