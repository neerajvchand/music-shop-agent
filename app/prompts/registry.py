"""Prompt module registry — load versioned modules from Supabase."""

from __future__ import annotations

import logging
from typing import Any

from app.supabase_client import get_supabase

logger = logging.getLogger(__name__)

# In-process cache for prompt modules to avoid repeated DB hits within a single call
_module_cache: dict[tuple[str, int, str | None], dict[str, Any]] = {}


def _cache_key(name: str, version: int, vertical: str | None) -> tuple[str, int, str | None]:
    return (name, version, vertical)


class PromptRegistry:
    """Load prompt modules from the `prompt_modules` table."""

    @staticmethod
    def get_module(name: str, version: int, vertical: str | None = None) -> dict[str, Any]:
        """Fetch a single module row by name, version, and optional vertical."""
        key = _cache_key(name, version, vertical)
        if key in _module_cache:
            return _module_cache[key]

        sb = get_supabase()
        query = (
            sb.table("prompt_modules")
            .select("name, version, vertical_slug, content, params_schema, status")
            .eq("name", name)
            .eq("version", version)
            .eq("status", "live")
        )
        if vertical:
            query = query.eq("vertical_slug", vertical)
        else:
            query = query.is_("vertical_slug", "null")

        result = query.limit(1).execute()
        if not result.data:
            raise ModuleNotFoundError(
                f"No live prompt module found: name={name} version={version} vertical={vertical}"
            )

        module = result.data[0]
        _module_cache[key] = module
        return module

    @staticmethod
    def get_latest_live_version(name: str, vertical: str | None = None) -> int:
        """Return the highest live version number for a module."""
        sb = get_supabase()
        query = (
            sb.table("prompt_modules")
            .select("version")
            .eq("name", name)
            .eq("status", "live")
            .order("version", desc=True)
        )
        if vertical:
            query = query.eq("vertical_slug", vertical)
        else:
            query = query.is_("vertical_slug", "null")

        result = query.limit(1).execute()
        if not result.data:
            raise ModuleNotFoundError(
                f"No live prompt module found: name={name} vertical={vertical}"
            )
        return result.data[0]["version"]

    @staticmethod
    def resolve_bindings(shop_id: str, vertical: str | None = None) -> list[dict[str, Any]]:
        """Return explicit module bindings for a shop. No auto-resolution — empty means fallback to monolithic prompt."""
        sb = get_supabase()
        result = sb.table("shop_prompt_bindings").select("*").eq("shop_id", shop_id).execute()
        return result.data or []

    @staticmethod
    def clear_cache() -> None:
        """Clear the in-process module cache. Useful in tests."""
        _module_cache.clear()
