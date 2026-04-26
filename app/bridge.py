"""Bidirectional audio bridge between Twilio Media Stream and Deepgram Voice Agent."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from enum import Enum

from fastapi import WebSocket, WebSocketDisconnect

from app.audio import build_clear_message, decode_twilio_media, encode_for_twilio
from app.call_logger import log_call
from app.config import settings
from app.deepgram_client import DeepgramAgentClient
from app.shops import Shop

logger = logging.getLogger(__name__)

MAX_CALL_DURATION = 300  # 5 minutes
SILENCE_TIMEOUT = 30  # seconds of silence before auto-goodbye
GOODBYE_DRAIN_MS = 400  # ms to let Twilio buffer flush before closing
FAREWELL_SAFETY_TIMEOUT = 8  # max seconds to wait for LLM-spoken farewell


class CallState(Enum):
    ACTIVE_CONVERSATION = "active_conversation"
    AWAITING_FAREWELL = "awaiting_farewell"
    CLOSING = "closing"


class CallStateTracker:
    """Encapsulate call state with logged transitions."""

    def __init__(self, call_sid: str) -> None:
        self.call_sid = call_sid
        self.state = CallState.ACTIVE_CONVERSATION

    def transition_to(self, new_state: CallState) -> None:
        old = self.state
        self.state = new_state
        logger.info(
            "State transition: %s -> %s (call=%s)",
            old.value, new_state.value, self.call_sid,
        )

    def is_active(self) -> bool:
        return self.state == CallState.ACTIVE_CONVERSATION

    def is_awaiting_farewell(self) -> bool:
        return self.state == CallState.AWAITING_FAREWELL

    def is_closing(self) -> bool:
        return self.state == CallState.CLOSING


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

        call_state = CallStateTracker(call_sid=call_sid or "unknown")
        silence_tracker = SilenceTracker()
        agent_audio_done_event = asyncio.Event()

        # Run both directions concurrently with a hard timeout
        twilio_task = asyncio.create_task(
            _twilio_to_deepgram(twilio_ws, deepgram, silence_tracker, call_state)
        )
        deepgram_task = asyncio.create_task(
            _deepgram_to_twilio(
                deepgram, twilio_ws, stream_sid, transcript_parts,
                call_state, silence_tracker, agent_audio_done_event,
            )
        )
        timeout_task = asyncio.create_task(
            _call_timeout(MAX_CALL_DURATION, twilio_ws, deepgram, stream_sid, call_state)
        )
        silence_task = asyncio.create_task(
            _silence_watchdog(silence_tracker, deepgram, shop, call_state)
        )
        farewell_task = asyncio.create_task(
            _farewell_safety_watchdog(call_state, deepgram, shop, agent_audio_done_event)
        )

        done, pending = await asyncio.wait(
            [twilio_task, deepgram_task, farewell_task],
            return_when=asyncio.FIRST_COMPLETED,
        )

        # If farewell flow completed, transition to CLOSING and let Twilio buffer flush
        if farewell_task in done:
            call_state.transition_to(CallState.CLOSING)
            await asyncio.sleep(GOODBYE_DRAIN_MS / 1000)

        # Cancel remaining tasks (including background silence/timeout tasks)
        background_tasks = [silence_task, timeout_task]
        for task in [*pending, *background_tasks]:
            task.cancel()
        # Await to suppress unhandled exceptions
        await asyncio.gather(*pending, *background_tasks, return_exceptions=True)

        # Check for exceptions in completed tasks
        for task in done:
            if task.exception() and not isinstance(task.exception(), asyncio.CancelledError):
                logger.error("Bridge task error: %s", task.exception())

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
    twilio_ws: WebSocket,
    deepgram: DeepgramAgentClient,
    silence_tracker: SilenceTracker,
    call_state: CallStateTracker | None = None,
) -> None:
    """Forward audio from Twilio to Deepgram."""
    try:
        while True:
            raw = await twilio_ws.receive_text()
            msg = json.loads(raw)

            if msg.get("event") == "media":
                # Hard-gate: only forward caller audio during active conversation
                if call_state and not call_state.is_active():
                    continue
                audio_bytes = decode_twilio_media(msg)
                await deepgram.send_audio(audio_bytes)
            elif msg.get("event") == "stop":
                logger.info("Twilio stream stopped (call=%s)", call_state.call_sid if call_state else "?")
                return
    except WebSocketDisconnect:
        logger.info("Twilio disconnected (call=%s)", call_state.call_sid if call_state else "?")


async def _deepgram_to_twilio(
    deepgram: DeepgramAgentClient,
    twilio_ws: WebSocket,
    stream_sid: str,
    transcript_parts: list[str],
    call_state: CallStateTracker | None = None,
    silence_tracker: SilenceTracker | None = None,
    agent_audio_done_event: asyncio.Event | None = None,
) -> None:
    """Handle events from Deepgram and forward audio to Twilio."""
    async for event in deepgram.receive_events():
        event_type = event.get("type", "")

        if event_type == "Audio":
            # Raw audio bytes from Deepgram -> encode for Twilio
            twilio_msg = encode_for_twilio(event["data"], stream_sid)
            await twilio_ws.send_text(twilio_msg)

        elif event_type == "UserStartedSpeaking":
            # Only mark silence activity if call is still active
            if call_state is None or call_state.is_active():
                if silence_tracker:
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
                    # Parse arguments and check confirmation
                    confirmed = False
                    reason = ""
                    try:
                        args = json.loads(fn.get("arguments", "{}"))
                        confirmed = args.get("caller_confirmed_done", False)
                        reason = args.get("reason", "")
                    except (json.JSONDecodeError, TypeError):
                        logger.warning("end_call: failed to parse arguments")

                    call_sid = call_state.call_sid if call_state else "?"

                    if not confirmed:
                        logger.warning(
                            "end_call rejected: caller_confirmed_done=false (reason=%r, call=%s)",
                            reason, call_sid,
                        )
                        await deepgram.send_function_call_response(
                            fn_id, "end_call",
                            '{"status": "ignored", "reason": "caller_confirmed_done must be true"}',
                        )
                        continue

                    logger.info("end_call accepted (reason=%r, call=%s)", reason, call_sid)
                    await deepgram.send_function_call_response(
                        fn_id, "end_call",
                        '{"status": "accepted, deliver farewell now"}',
                    )
                    if call_state:
                        call_state.transition_to(CallState.AWAITING_FAREWELL)
                    return
                else:
                    logger.warning(
                        "Unhandled FunctionCallRequest: %s (client_side=%s)", fn_name, client_side
                    )

        elif event_type == "AgentAudioDone":
            if call_state and call_state.is_awaiting_farewell() and agent_audio_done_event:
                logger.info("AgentAudioDone received in AWAITING_FAREWELL (call=%s)", call_state.call_sid)
                agent_audio_done_event.set()

        elif event_type in ("Error", "Warning"):
            logger.warning("Deepgram %s: %s", event_type, event.get("message", event))


async def _farewell_safety_watchdog(
    call_state: CallStateTracker,
    deepgram: DeepgramAgentClient,
    shop: Shop,
    agent_audio_done_event: asyncio.Event,
) -> None:
    """Wait for LLM farewell to finish; inject fallback if safety timeout fires."""
    # Poll until we enter AWAITING_FAREWELL (or CLOSING)
    while not call_state.is_awaiting_farewell():
        if call_state.is_closing():
            return
        await asyncio.sleep(0.2)

    # Now in AWAITING_FAREWELL — wait for AgentAudioDone
    try:
        await asyncio.wait_for(
            agent_audio_done_event.wait(),
            timeout=FAREWELL_SAFETY_TIMEOUT,
        )
        logger.info("Farewell completed via LLM (call=%s)", call_state.call_sid)
    except asyncio.TimeoutError:
        logger.warning(
            "LLM farewell did not complete within %ds — injecting fallback (call=%s)",
            FAREWELL_SAFETY_TIMEOUT, call_state.call_sid,
        )
        await deepgram.inject_goodbye(shop.farewell)
        # Wait for injected farewell to finish playing
        try:
            await asyncio.wait_for(
                agent_audio_done_event.wait(),
                timeout=FAREWELL_SAFETY_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.error("Even fallback farewell did not complete (call=%s)", call_state.call_sid)


async def _silence_watchdog(
    silence_tracker: SilenceTracker,
    deepgram: DeepgramAgentClient,
    shop: Shop | None = None,
    call_state: CallStateTracker | None = None,
) -> None:
    """If no caller audio for SILENCE_TIMEOUT seconds, transition to farewell.

    Runs until cancelled — never returns on its own.
    """
    while True:
        await asyncio.sleep(5)
        if not (call_state is None or call_state.is_active()):
            continue
        if silence_tracker.elapsed() >= SILENCE_TIMEOUT:
            call_sid = call_state.call_sid if call_state else "?"
            logger.info("Silence timeout (%ds) reached, ending call (call=%s)", SILENCE_TIMEOUT, call_sid)
            if call_state:
                call_state.transition_to(CallState.AWAITING_FAREWELL)
            farewell_msg = shop.farewell if shop else None
            await deepgram.inject_goodbye(farewell_msg)
            continue


async def _call_timeout(
    seconds: int,
    twilio_ws: WebSocket,
    deepgram: DeepgramAgentClient,
    stream_sid: str | None,
    call_state: CallStateTracker | None = None,
) -> None:
    """Enforce max call duration. Runs until cancelled."""
    await asyncio.sleep(seconds)
    call_sid = call_state.call_sid if call_state else "?"
    logger.info("Call reached %ds limit, closing (call=%s)", seconds, call_sid)

    try:
        if call_state:
            call_state.transition_to(CallState.AWAITING_FAREWELL)
        await deepgram.inject_goodbye()
    except Exception as e:
        logger.warning("Could not send goodbye: %s", e)

    # Keep alive until cancelled — farewell_safety_watchdog handles disconnect
    while True:
        await asyncio.sleep(5)
