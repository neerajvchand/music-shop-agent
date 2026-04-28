from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

from fastapi import FastAPI, WebSocket, Request
from fastapi.responses import JSONResponse

from app.config import settings
from app.shops import get_shop_by_slug
from app.twilio_handlers import handle_voice_webhook
from app.bridge import run_bridge
from app.owner.daily import generate_daily_summary, get_daily_digest
from app.owner.decisions import list_decisions, resolve_decision
from app.owner.drift import check_drift
from app.sms.client import send_daily_digest as send_daily_digest_sms
from app.booking.persistence import expire_drafts

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Music Shop Voice Agent", version="0.3.0")


@app.on_event("startup")
async def startup() -> None:
    """Validate config and smoke-test Supabase on startup."""
    logger.info("Starting up — validating config...")

    try:
        from app.supabase_client import get_supabase

        result = get_supabase().table("shops").select("id").limit(1).execute()
        logger.debug("Supabase connected, shops table accessible (%d rows sampled)", len(result.data))
    except Exception as e:
        logger.error("Supabase smoke test failed: %s", e)

    # Clean up expired drafts
    try:
        await expire_drafts()
        logger.info("Expired drafts cleaned up")
    except Exception as e:
        logger.warning("Draft cleanup failed: %s", e)

    logger.info("Ready — listening on %s", settings.app_base_url)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "0.3.0"}


@app.post("/twilio/voice")
async def twilio_voice(request: Request):
    return await handle_voice_webhook(request)


@app.websocket("/twilio/ws")
async def twilio_websocket(websocket: WebSocket):
    await run_bridge(websocket)


# ---------------------------------------------------------------------------
# Owner surface APIs
# ---------------------------------------------------------------------------

@app.get("/api/shops/{shop_id}/digest")
async def get_digest(shop_id: str, summary_date: str | None = None):
    """Get daily digest for a shop."""
    if summary_date is None:
        summary_date = str((datetime.now(timezone.utc).date() - timedelta(days=1)))
    summary = await get_daily_digest(shop_id, date.fromisoformat(summary_date))
    if not summary:
        return JSONResponse({"error": "No summary found"}, status_code=404)
    return summary


@app.post("/api/shops/{shop_id}/digest/generate")
async def post_generate_digest(shop_id: str, summary_date: str | None = None):
    """Generate daily digest on-demand."""
    target_date = date.fromisoformat(summary_date) if summary_date else (datetime.now(timezone.utc).date() - timedelta(days=1))
    summary = await generate_daily_summary(shop_id, target_date)
    return summary


@app.post("/api/shops/{shop_id}/digest/send")
async def post_send_digest(shop_id: str, summary_date: str | None = None):
    """Send daily digest SMS to owner."""
    target_date = summary_date or str((datetime.now(timezone.utc).date() - timedelta(days=1)))
    sid = await send_daily_digest_sms(shop_id, target_date)
    if not sid:
        return JSONResponse({"error": "Failed to send digest"}, status_code=500)
    return {"sent": True, "message_sid": sid}


@app.get("/api/shops/{shop_id}/decisions")
async def get_decisions(shop_id: str, status: str = "pending"):
    """List owner decisions."""
    decisions = await list_decisions(shop_id, status)
    return {"decisions": decisions}


@app.post("/api/shops/{shop_id}/decisions/{decision_id}/resolve")
async def post_resolve_decision(shop_id: str, decision_id: str, resolution: str):
    """Resolve a decision."""
    ok = await resolve_decision(decision_id, resolution)
    return {"resolved": ok}


@app.get("/api/shops/{shop_id}/drift")
async def get_drift(shop_id: str):
    """Check for drift alerts."""
    alerts = await check_drift(shop_id)
    return {"alerts": alerts}


# ---------------------------------------------------------------------------
# Evals API
# ---------------------------------------------------------------------------

@app.post("/api/evals/run")
async def post_run_eval(module_name: str, module_version: int, vertical: str):
    """Run an eval suite for a prompt module."""
    from app.evals.harness import run_eval_suite
    result = await run_eval_suite(module_name, module_version, vertical)
    return result
