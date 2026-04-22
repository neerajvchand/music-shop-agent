from __future__ import annotations

import time
from typing import Any

from pydantic import BaseModel


class Shop(BaseModel):
    id: str
    slug: str
    name: str
    status: str
    twilio_number: str
    owner_name: str
    owner_phone: str
    owner_email: str | None = None
    timezone: str
    locale: str
    greeting: str
    system_prompt: str
    voice_id: str
    llm_provider: str
    llm_model: str
    business_hours_json: Any
    services_json: Any
    tool_definitions_json: Any
    gcal_calendar_id: str | None = None
    gcal_service_account_email: str | None = None
    approval_mode: str
    created_at: str | None = None
    updated_at: str | None = None


# Simple in-process cache: key -> (Shop, timestamp)
_cache: dict[str, tuple[Shop, float]] = {}
_CACHE_TTL = 60.0  # seconds


def _cache_get(key: str) -> Shop | None:
    entry = _cache.get(key)
    if entry and (time.time() - entry[1]) < _CACHE_TTL:
        return entry[0]
    if entry:
        del _cache[key]
    return None


def _cache_set(key: str, shop: Shop) -> None:
    _cache[key] = (shop, time.time())


def _row_to_shop(row: dict) -> Shop:
    return Shop(**row)


async def get_shop_by_twilio_number(number: str) -> Shop | None:
    cached = _cache_get(f"twilio:{number}")
    if cached:
        return cached

    from app.supabase_client import get_supabase

    result = (
        get_supabase()
        .table("shops")
        .select("*")
        .eq("twilio_number", number)
        .eq("status", "active")
        .limit(1)
        .execute()
    )

    if not result.data:
        return None

    shop = _row_to_shop(result.data[0])
    _cache_set(f"twilio:{number}", shop)
    _cache_set(f"slug:{shop.slug}", shop)
    return shop


async def get_shop_by_slug(slug: str) -> Shop | None:
    cached = _cache_get(f"slug:{slug}")
    if cached:
        return cached

    from app.supabase_client import get_supabase

    result = (
        get_supabase()
        .table("shops")
        .select("*")
        .eq("slug", slug)
        .eq("status", "active")
        .limit(1)
        .execute()
    )

    if not result.data:
        return None

    shop = _row_to_shop(result.data[0])
    _cache_set(f"slug:{shop.slug}", shop)
    _cache_set(f"twilio:{shop.twilio_number}", shop)
    return shop
