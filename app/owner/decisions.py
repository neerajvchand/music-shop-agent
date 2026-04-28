"""Owner decisions inbox — create, list, resolve."""

from __future__ import annotations

import logging
from typing import Any

from app.supabase_client import get_supabase

logger = logging.getLogger(__name__)


async def create_decision(
    shop_id: str,
    decision_type: str,
    title: str,
    body: str,
    context: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Create a new decision for the shop owner."""
    sb = get_supabase()
    row = {
        "shop_id": shop_id,
        "decision_type": decision_type,
        "title": title,
        "body": body,
        "context_json": context or {},
        "status": "pending",
    }
    try:
        result = sb.table("owner_decisions").insert(row).execute()
        return result.data[0] if result.data else None
    except Exception as e:
        logger.error("Failed to create decision: %s", e)
        return None


async def list_decisions(
    shop_id: str,
    status: str = "pending",
    limit: int = 50,
) -> list[dict[str, Any]]:
    """List decisions for a shop."""
    sb = get_supabase()
    result = (
        sb.table("owner_decisions")
        .select("*")
        .eq("shop_id", shop_id)
        .eq("status", status)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data or []


async def resolve_decision(
    decision_id: str,
    resolution: str,  # approved, dismissed, auto_resolved
) -> bool:
    """Resolve a decision."""
    sb = get_supabase()
    try:
        sb.table("owner_decisions").update({
            "status": resolution,
            "resolved_at": "now()",
        }).eq("id", decision_id).execute()
        return True
    except Exception as e:
        logger.error("Failed to resolve decision %s: %s", decision_id, e)
        return False
