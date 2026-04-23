from __future__ import annotations

import logging
from urllib.parse import urlparse

from fastapi import Request
from fastapi.responses import Response

from app.config import settings
from app.shops import get_shop_by_twilio_number

logger = logging.getLogger(__name__)

CONSENT_DISCLOSURE = "This call may be recorded for quality purposes."


async def handle_voice_webhook(request: Request) -> Response:
    """Handle Twilio voice webhook — resolve shop, return TwiML."""
    form = await request.form()
    to_number = str(form.get("To", ""))
    caller = str(form.get("From", ""))
    logger.info("Incoming call to=%s from=%s", to_number, caller)

    shop = await get_shop_by_twilio_number(to_number)

    if not shop:
        logger.warning("No shop found for number %s", to_number)
        twiml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            "<Say>We're sorry, we can't locate the shop for this number. Goodbye.</Say>"
            "<Hangup/>"
            "</Response>"
        )
        return Response(content=twiml, media_type="application/xml")

    # Strip https:// to build wss:// URL for Twilio Stream
    parsed = urlparse(settings.app_base_url)
    ws_host = parsed.hostname
    if parsed.port:
        ws_host = f"{ws_host}:{parsed.port}"

    stream_url = f"wss://{ws_host}/twilio/ws"

    twiml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        f"<Say>{CONSENT_DISCLOSURE}</Say>"
        "<Connect>"
        f'<Stream url="{stream_url}">'
        f'<Parameter name="shop" value="{shop.slug}"/>'
        "</Stream>"
        "</Connect>"
        "</Response>"
    )
    return Response(content=twiml, media_type="application/xml")
