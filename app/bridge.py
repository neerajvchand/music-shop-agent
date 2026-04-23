"""Bidirectional audio bridge between Twilio Media Stream and Deepgram Voice Agent."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import WebSocket, WebSocketDisconnect

from app.audio import build_clear_message, decode_twilio_media, encode_for_twilio
from app.call_logger import log_call
from app.config import settings
from app.deepgram_client import DeepgramAgentClient
from app.shops import Shop

logger = logging.getLogger(__name__)

MAX_CALL_DURATION = 300  # 5 minutes
SILENCE_TIMEOUT = 30  # seconds of silence before auto-goodbye
GOODBYE_DRAIN_MS = 4500  # ms to let final TTS play before closing


class SilenceTracker:
    """Track time since last caller audio activity."""

    def __init__(self) -> None:
        self._last_activity: float = asyncio.get_event_loop().time()

    def mark_activity(self) -> None:
        self._last_activity = asyncio.get_event_loop().time()

    def elapsed(self) -> float:
        return asyncio.get_event_loop().time() - self._last_activity


async def run_bridge(twilio_ws: WebSocket) -> None:
    """Bridge audio between Twilio and Deepgram for a single call."""
    await twilio_ws.accept()

    stream_sid: str | None = None
    call_sid: str | None = None
    caller_phone: str | None = None
    shop: Shop | None = None
    transcript_parts: list[str] = []
    started_at = datetime.now(timezone.utc)
    deepgram: DeepgramAgentClient | None = None

    try:
        # Wait for Twilio start event — returns streamSid, callSid, caller phone, and shop slug
        stream_sid, call_sid, caller_phone, shop_slug = await _wait_for_start(twilio_ws)

        # Resolve shop from custom parameter
        from app.shops import get_shop_by_slug
        shop = await get_shop_by_slug(shop_slug) if shop_slug else None
        if not shop:
            logger.warning("No shop resolved from start event (slug=%r), closing", shop_slug)
            return

        logger.info("Bridge started: stream=%s call=%s shop=%s", stream_sid, call_sid, shop.slug)

        # Connect to Deepgram
        deepgram = DeepgramAgentClient(settings.deepgram_api_key, shop)
        await deepgram.connect()

        silence_tracker = SilenceTracker()
        end_call_event = asyncio.Event()

        # Run both directions concurrently with a hard timeout
        twilio_task = asyncio.create_task(
            _twilio_to_deepgram(twilio_ws, deepgram, silence_tracker)
        )
        deepgram_task = asyncio.create_task(
            _deepgram_to_twilio(deepgram, twilio_ws, stream_sid, transcript_parts, end_call_event, silence_tracker, shop)
        )
        timeout_task = asyncio.create_task(
            _call_timeout(MAX_CALL_DURATION, twilio_ws, deepgram, stream_sid)
        )
        silence_task = asyncio.create_task(
            _silence_watchdog(silence_tracker, deepgram, end_call_event)
        )

        done, pending = await asyncio.wait(
            [twilio_task, deepgram_task, timeout_task, silence_task],
            return_when=asyncio.FIRST_COMPLETED,
        )

        # Cancel remaining tasks
        for task in pending:
            task.cancel()
        # Await to suppress unhandled exceptions
        await asyncio.gather(*pending, return_exceptions=True)

        # Check for exceptions in completed tasks
        for task in done:
            if task.exception() and not isinstance(task.exception(), asyncio.CancelledError):
                logger.error("Bridge task error: %s", task.exception())

        # Let final TTS drain before closing if end_call was triggered
        if end_call_event.is_set():
            await asyncio.sleep(GOODBYE_DRAIN_MS / 1000)

    except WebSocketDisconnect:
        logger.info("Twilio WebSocket disconnected")
    except Exception as e:
        logger.error("Bridge error: %s", e, exc_info=True)
    finally:
        ended_at = datetime.now(timezone.utc)
        transcript = "\n".join(transcript_parts)

        if deepgram:
            await deepgram.close()

        try:
            await twilio_ws.close()
        except Exception:
            pass

        # Log the call
# Log the call (only if we resolved a shop)
        if shop is not None:
            try:
                await log_call(
                    shop_id=shop.id,
                    twilio_call_sid=call_sid,
                    started_at=started_at,
                    ended_at=ended_at,
                    transcript=transcript,
                    caller_phone=caller_phone,
                )
            except Exception as e:
                logger.error("Failed to log call: %s", e)


async def _wait_for_start(twilio_ws: WebSocket) -> tuple[str, str | None, str | None, str | None]:
    """Wait for the Twilio 'start' event and return (streamSid, callSid, callerPhone, shopSlug)."""
    while True:
        raw = await twilio_ws.receive_text()
        msg = json.loads(raw)
        if msg.get("event") == "start":
            start = msg["start"]
            custom = start.get("customParameters", {}) or {}
            return (
                start["streamSid"],
                start.get("callSid"),
                custom.get("From"),
                custom.get("shop"),
            )


async def _twilio_to_deepgram(
    twilio_ws: WebSocket, deepgram: DeepgramAgentClient, silence_tracker: SilenceTracker
) -> None:
    """Forward audio from Twilio to Deepgram."""
    try:
        while True:
            raw = await twilio_ws.receive_text()
            msg = json.loads(raw)

            if msg.get("event") == "media":
                audio_bytes = decode_twilio_media(msg)
                await deepgram.send_audio(audio_bytes)
            elif msg.get("event") == "stop":
                logger.info("Twilio stream stopped")
                return
    except WebSocketDisconnect:
        logger.info("Twilio disconnected in twilio_to_deepgram")


async def _deepgram_to_twilio(
    deepgram: DeepgramAgentClient,
    twilio_ws: WebSocket,
    stream_sid: str,
    transcript_parts: list[str],
    end_call_event: asyncio.Event,
    silence_tracker: SilenceTracker,
    shop: Shop,
) -> None:
    """Handle events from Deepgram and forward audio to Twilio."""
    async for event in deepgram.receive_events():
        event_type = event.get("type", "")

        if event_type == "Audio":
            # Raw audio bytes from Deepgram -> encode for Twilio
            twilio_msg = encode_for_twilio(event["data"], stream_sid)
            await twilio_ws.send_text(twilio_msg)

        elif event_type == "UserStartedSpeaking":
            silence_tracker.mark_activity()
            # Barge-in: clear Twilio's audio buffer
            await twilio_ws.send_text(build_clear_message(stream_sid))

        elif event_type == "ConversationText":
            role = event.get("role", "unknown")
            content = event.get("content", "")
            transcript_parts.append(f"{role}: {content}")

        elif event_type == "FunctionCallRequest":
            for fn in event.get("functions", []):
                fn_name = fn.get("name", "unknown")
                fn_id = fn.get("id", "")
                client_side = fn.get("client_side", False)

                if fn_name == "end_call" and client_side:
                    logger.info("end_call function requested, initiating hangup")
                    await deepgram.send_function_call_response(fn_id, "end_call", "ok")
                    await deepgram.inject_goodbye(shop.farewell)
                    end_call_event.set()
                    return
                else:
                    logger.warning(
                        "Unhandled FunctionCallRequest: %s (client_side=%s)", fn_name, client_side
                    )

        elif event_type in ("Error", "Warning"):
            logger.warning("Deepgram %s: %s", event_type, event.get("message", event))


async def _silence_watchdog(
    silence_tracker: SilenceTracker,
    deepgram: DeepgramAgentClient,
    end_call_event: asyncio.Event,
) -> None:
    """If no caller audio for SILENCE_TIMEOUT seconds, inject goodbye and signal end."""
    while True:
        await asyncio.sleep(1)
        if silence_tracker.elapsed() >= SILENCE_TIMEOUT:
            logger.info("Silence timeout (%ds) reached, injecting goodbye", SILENCE_TIMEOUT)
            await deepgram.inject_goodbye()
            end_call_event.set()
            return


async def _call_timeout(
    seconds: int,
    twilio_ws: WebSocket,
    deepgram: DeepgramAgentClient,
    stream_sid: str | None,
) -> None:
    """Enforce max call duration."""
    await asyncio.sleep(seconds)
    logger.info("Call reached %ds limit, closing", seconds)

    try:
        await deepgram.inject_goodbye()
        # Give a moment for the goodbye to be spoken
        await asyncio.sleep(3)
    except Exception as e:
        logger.warning("Could not send goodbye: %s", e)
