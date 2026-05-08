"""HMAC-authenticated client for the Vercel /api/agent/* calendar endpoints.

Architecture: Railway agent → Vercel → Google. Railway never holds Google
OAuth tokens; Vercel is the single point of contact for the Google Calendar
API. This client signs every request with HMAC-SHA256 over
`f"{shop_id}:{timestamp_ms}"` so the Vercel `_auth.ts` verifier can
validate it against the shared `AGENT_API_SECRET`.

All public functions return either a parsed dict on success or raise
`AgentApiError`. Bridge code maps that to the canonical structured-error
shape `{"error": <code>, "message": <text>}` for the LLM.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_S = 15.0


class AgentApiError(Exception):
    """Raised when the Vercel agent API returns a non-2xx response or is unreachable."""

    def __init__(self, message: str, *, status: int | None = None, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


def _sign(shop_id: str, timestamp_ms: int) -> tuple[str, str]:
    """Return (payload, signature_hex). Identical shape to dashboard/_auth.ts."""
    payload = f"{shop_id}:{timestamp_ms}"
    signature = hmac.new(
        settings.agent_api_secret.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return payload, signature


def _build_headers(shop_id: str, timestamp_ms: int | None = None) -> dict[str, str]:
    if not settings.agent_api_secret:
        raise AgentApiError("agent_api_secret is not configured on Railway")
    if not settings.dashboard_base_url:
        raise AgentApiError("dashboard_base_url is not configured on Railway")
    ts = timestamp_ms if timestamp_ms is not None else int(time.time() * 1000)
    _, signature = _sign(shop_id, ts)
    return {
        "x-shop-id": shop_id,
        "x-request-timestamp": str(ts),
        "x-agent-signature": signature,
        "content-type": "application/json",
    }


def _endpoint(path: str) -> str:
    base = settings.dashboard_base_url.rstrip("/")
    return f"{base}{path}"


async def check_availability(
    shop_id: str,
    *,
    date: str,
    duration_minutes: int,
    timezone: str | None = None,
) -> dict[str, Any]:
    """POST /api/agent/check-availability. Returns parsed JSON body."""
    url = _endpoint("/api/agent/check-availability")
    body = {
        "date": date,
        "durationMinutes": duration_minutes,
    }
    if timezone:
        body["timezone"] = timezone

    headers = _build_headers(shop_id)
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_S) as client:
            resp = await client.post(url, json=body, headers=headers)
    except httpx.HTTPError as e:
        logger.warning("check_availability transport error: %s", e)
        raise AgentApiError(f"network error: {e}") from e

    if resp.status_code >= 400:
        logger.info(
            "check_availability non-2xx (status=%s body=%s)",
            resp.status_code, resp.text[:300],
        )
        raise AgentApiError(
            f"check_availability returned {resp.status_code}",
            status=resp.status_code,
            body=_safe_json(resp),
        )
    return resp.json()


async def create_booking(
    shop_id: str,
    *,
    customer_name: str,
    customer_phone: str,
    service: str,
    start_time: str,
    duration_minutes: int,
    notes: str | None = None,
) -> dict[str, Any]:
    """POST /api/agent/create-booking. Returns parsed JSON body."""
    url = _endpoint("/api/agent/create-booking")
    body: dict[str, Any] = {
        "customerName": customer_name,
        "customerPhone": customer_phone,
        "service": service,
        "startTime": start_time,
        "durationMinutes": duration_minutes,
    }
    if notes:
        body["notes"] = notes

    headers = _build_headers(shop_id)
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_S) as client:
            resp = await client.post(url, json=body, headers=headers)
    except httpx.HTTPError as e:
        logger.warning("create_booking transport error: %s", e)
        raise AgentApiError(f"network error: {e}") from e

    if resp.status_code == 409:
        # Slot already booked. Surface as a structured error the bridge can
        # turn into "that time was just booked, want to pick another?"
        raise AgentApiError(
            "slot_taken", status=409, body=_safe_json(resp),
        )
    if resp.status_code >= 400:
        logger.info(
            "create_booking non-2xx (status=%s body=%s)",
            resp.status_code, resp.text[:300],
        )
        raise AgentApiError(
            f"create_booking returned {resp.status_code}",
            status=resp.status_code,
            body=_safe_json(resp),
        )
    return resp.json()


def _safe_json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except Exception:
        return {"raw": resp.text[:500]}
