"""Google Calendar API client with OAuth token management."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.config import settings
from app.supabase_client import get_supabase

logger = logging.getLogger(__name__)

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3"


class CalendarClient:
    """Low-level Google Calendar API client."""

    def __init__(self, shop_id: str, integration: dict[str, Any]):
        self.shop_id = shop_id
        self.integration = integration
        self._access_token: str | None = integration.get("access_token")
        self._token_expires_at: datetime | None = None
        if integration.get("token_expires_at"):
            try:
                self._token_expires_at = datetime.fromisoformat(integration["token_expires_at"].replace("Z", "+00:00"))
            except ValueError:
                pass

    async def _ensure_token(self) -> str | None:
        """Refresh access token if expired."""
        if self._access_token and self._token_expires_at and datetime.now(timezone.utc) < self._token_expires_at:
            return self._access_token

        refresh_token = self.integration.get("refresh_token")
        if not refresh_token:
            logger.error("No refresh token for shop %s", self.shop_id)
            await self._mark_error("No refresh token available")
            return None

        # Refresh
        payload = {
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(GOOGLE_TOKEN_URL, data=payload)
                resp.raise_for_status()
                data = resp.json()
                self._access_token = data["access_token"]
                expires_in = data.get("expires_in", 3600)
                self._token_expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

                # Persist back to DB
                sb = get_supabase()
                sb.table("shop_integrations").update({
                    "access_token": self._access_token,
                    "token_expires_at": self._token_expires_at.isoformat(),
                    "status": "connected",
                    "last_error": None,
                }).eq("shop_id", self.shop_id).eq("provider", "google_calendar").execute()

                return self._access_token
        except Exception as e:
            logger.error("Token refresh failed for shop %s: %s", self.shop_id, e)
            await self._mark_error(str(e))
            return None

    async def _mark_error(self, error: str) -> None:
        sb = get_supabase()
        sb.table("shop_integrations").update({
            "status": "error",
            "last_error": error,
        }).eq("shop_id", self.shop_id).eq("provider", "google_calendar").execute()

    async def free_busy(
        self,
        time_min: datetime,
        time_max: datetime,
        calendar_id: str = "primary",
    ) -> list[dict[str, Any]]:
        """Query free/busy for a calendar. Returns busy intervals."""
        token = await self._ensure_token()
        if not token:
            return []

        body = {
            "timeMin": time_min.isoformat(),
            "timeMax": time_max.isoformat(),
            "timeZone": "UTC",
            "items": [{"id": calendar_id}],
        }
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{GOOGLE_CALENDAR_API}/freeBusy",
                headers={"Authorization": f"Bearer {token}"},
                json=body,
            )
            resp.raise_for_status()
            data = resp.json()
            calendars = data.get("calendars", {})
            cal = calendars.get(calendar_id, calendars.get("primary", {}))
            return cal.get("busy", [])

    async def create_event(
        self,
        calendar_id: str,
        summary: str,
        start: datetime,
        end: datetime,
        description: str = "",
        timezone: str = "UTC",
    ) -> dict[str, Any] | None:
        """Create a calendar event. Returns the created event dict."""
        token = await self._ensure_token()
        if not token:
            return None

        body = {
            "summary": summary,
            "description": description,
            "start": {"dateTime": start.isoformat(), "timeZone": timezone},
            "end": {"dateTime": end.isoformat(), "timeZone": timezone},
        }
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{GOOGLE_CALENDAR_API}/calendars/{calendar_id}/events",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json=body,
            )
            resp.raise_for_status()
            return resp.json()

    async def delete_event(self, calendar_id: str, event_id: str) -> bool:
        """Delete a calendar event."""
        token = await self._ensure_token()
        if not token:
            return False

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.delete(
                f"{GOOGLE_CALENDAR_API}/calendars/{calendar_id}/events/{event_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
            return resp.status_code == 204


async def get_calendar_client(shop_id: str) -> CalendarClient | None:
    """Load integration and return a CalendarClient for the shop."""
    sb = get_supabase()
    result = (
        sb.table("shop_integrations")
        .select("*")
        .eq("shop_id", shop_id)
        .eq("provider", "google_calendar")
        .eq("status", "connected")
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    return CalendarClient(shop_id, result.data[0])
