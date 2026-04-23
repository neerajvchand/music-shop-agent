from __future__ import annotations

import logging

from fastapi import FastAPI, WebSocket, Request
from fastapi.responses import JSONResponse

from app.config import settings
from app.shops import get_shop_by_slug
from app.twilio_handlers import handle_voice_webhook
from app.bridge import run_bridge

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Music Shop Voice Agent", version="0.1.0")


@app.on_event("startup")
async def startup() -> None:
    """Validate config and smoke-test Supabase on startup."""
    logger.info("Starting up — validating config...")

    # Config already validated by pydantic-settings at import time.
    # Smoke-test Supabase connection.
    try:
        from app.supabase_client import get_supabase

        result = get_supabase().table("shops").select("id").limit(1).execute()
        logger.debug("Supabase connected, shops table accessible (%d rows sampled)", len(result.data))
    except Exception as e:
        logger.error("Supabase smoke test failed: %s", e)
        # Don't crash — Railway needs the health endpoint up to report status

    logger.info("Ready — listening on %s", settings.app_base_url)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/twilio/voice")
async def twilio_voice(request: Request):
    return await handle_voice_webhook(request)


@app.websocket("/twilio/ws")
async def twilio_websocket(websocket: WebSocket):
    # Shop slug arrives in Twilio's start event customParameters, not as a query param.
    # run_bridge handles accepting the connection and resolving the shop.
    await run_bridge(websocket)