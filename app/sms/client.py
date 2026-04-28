"""Twilio SMS client for customer and owner notifications."""

from __future__ import annotations

import logging
from typing import Any

from twilio.rest import Client as TwilioClient

from app.config import settings
from app.shops import Shop
from app.supabase_client import get_supabase

logger = logging.getLogger(__name__)

_twilio_client: TwilioClient | None = None


def _get_twilio() -> TwilioClient:
    global _twilio_client
    if _twilio_client is None:
        _twilio_client = TwilioClient(settings.twilio_account_sid, settings.twilio_auth_token)
    return _twilio_client


async def send_sms(to: str, body: str, from_number: str | None = None) -> str | None:
    """Send an SMS. Returns message SID or None on failure."""
    try:
        client = _get_twilio()
        msg = client.messages.create(
            body=body,
            from_=from_number or settings.twilio_sms_number,
            to=to,
        )
        logger.info("SMS sent to %s: sid=%s", to, msg.sid)
        return msg.sid
    except Exception as e:
        logger.error("SMS send failed to %s: %s", to, e)
        return None


async def send_owner_alert(shop: Shop, decision_type: str, context: dict[str, Any]) -> str | None:
    """Send an owner notification based on their rules."""
    rules = shop.owner_notification_rules_json
    if isinstance(rules, str):
        import json
        rules = json.loads(rules)

    should_notify = False
    if decision_type == "first_time_customer" and rules.get("first_time_customer"):
        should_notify = True
    elif decision_type == "high_value_service" and rules.get("high_value_service"):
        should_notify = True
    elif decision_type == "after_hours" and rules.get("after_hours"):
        should_notify = True
    elif rules.get("all_bookings"):
        should_notify = True

    if not should_notify:
        return None

    if not shop.owner_phone:
        return None

    from app.sms.templates import render_owner_alert
    body = render_owner_alert(shop, decision_type, context)
    return await send_sms(shop.owner_phone, body)


async def send_daily_digest(shop: Shop, summary_date: str) -> str | None:
    """Send the daily summary SMS to the owner."""
    if not shop.owner_phone:
        return None

    sb = get_supabase()
    result = (
        sb.table("daily_summaries")
        .select("*")
        .eq("shop_id", shop.id)
        .eq("summary_date", summary_date)
        .limit(1)
        .execute()
    )
    if not result.data:
        logger.info("No daily summary for %s on %s", shop.slug, summary_date)
        return None

    summary = result.data[0]
    from app.sms.templates import render_digest
    body = render_digest(shop, summary)
    sid = await send_sms(shop.owner_phone, body)

    if sid:
        sb.table("daily_summaries").update({"sent_at": "now()"}).eq("id", summary["id"]).execute()

    return sid
