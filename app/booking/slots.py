"""Slot definitions per vertical — what information must be collected to book."""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Callable

from app.supabase_client import get_supabase

logger = logging.getLogger(__name__)

SlotValidator = Callable[[Any], tuple[bool, str]]


def _validate_phone(value: Any) -> tuple[bool, str]:
    s = str(value).strip()
    # Allow +1-XXX-XXX-XXXX, (XXX) XXX-XXXX, XXX-XXX-XXXX, XXXXXXXXXX
    digits = re.sub(r"\D", "", s)
    if len(digits) == 10:
        return True, ""
    if len(digits) == 11 and digits.startswith("1"):
        return True, ""
    return False, "Please provide a 10-digit phone number."


def _validate_select(options: list[str]) -> SlotValidator:
    def validator(value: Any) -> tuple[bool, str]:
        s = str(value).strip().lower()
        if s in [o.lower() for o in options]:
            return True, ""
        return False, f"Please choose one of: {', '.join(options)}"
    return validator


def _validate_text(min_len: int = 1) -> SlotValidator:
    def validator(value: Any) -> tuple[bool, str]:
        s = str(value).strip()
        if len(s) >= min_len:
            return True, ""
        return False, "Please provide a valid answer."
    return validator


def _validate_number() -> SlotValidator:
    def validator(value: Any) -> tuple[bool, str]:
        try:
            int(value)
            return True, ""
        except (ValueError, TypeError):
            return False, "Please provide a number."
    return validator


SLOT_VALIDATORS: dict[str, Callable[..., SlotValidator]] = {
    "phone": lambda **_kw: _validate_phone,
    "select": lambda options, **_kw: _validate_select(options),
    "text": lambda min_len=1, **_kw: _validate_text(min_len),
    "number": lambda **_kw: _validate_number(),
}


def get_slots_for_vertical(vertical_slug: str) -> list[dict[str, Any]]:
    """Fetch slot definitions from verticals table."""
    sb = get_supabase()
    result = sb.table("verticals").select("default_slots_json").eq("slug", vertical_slug).limit(1).execute()
    if not result.data:
        logger.warning("No vertical found for %s, returning empty slots", vertical_slug)
        return []
    slots = result.data[0].get("default_slots_json", [])
    return slots if isinstance(slots, list) else json.loads(slots)
