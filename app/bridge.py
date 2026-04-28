"""Bidirectional audio bridge between Twilio Media Stream and Deepgram Voice Agent."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from enum import Enum

from fastapi import WebSocket, WebSocketDisconnect

from app.audio import build_clear_message, decode_twilio_media, encode_for_twilio
from app.booking.persistence import load_draft, save_draft
from app.booking.state import BookingStateMachine
from app.calendar.atomic import atomic_book, BookingConflictError, CalendarWriteError
from app.call_logger import log_call
from app.config import settings
from app.deepgram_client import DeepgramAgentClient
from app.owner.decisions import create_decision
from app.prompts.composer import CallContext
from app.prompts.state_machine import ConversationState, StateTransition
from app.shops import Shop
from app.sms.client import send_owner_alert, send_sms

logger = logging.getLogger(__name__)

MAX_CALL_DURATION = 300  # 5 minutes
SILENCE_TIMEOUT = 30  # seconds of silence before auto-goodbye
SILENCE_CHECKIN_THRESHOLD = 15  # seconds of silence before "still there?" check-in
GOODBYE_DRAIN_MS = 3000  # ms to let Twilio buffer flush before closing
FAREWELL_SAFETY_TIMEOUT = 8  # max seconds to wait for LLM-spoken farewell


class BridgeCallState(Enum):
    ACTIVE_CONVERSATION = "active_conversation"
    AWAITING_FAREWELL = "awaiting_farewell"
    CLOSING = "closing"


class BridgeCallStateTracker:
    """Encapsulate call state with logged transitions."""

    def __init__(self, call_sid: str) -> None:
        self.call_sid = call_sid
        self.state = BridgeCallState.ACTIVE_CONVERSATION

    def transition_to(self, new_state: BridgeCallState) -> None:
        old = self.state
        self.state = new_state
        logger.info(
            "Bridge state transition: %s -> %s (call=%s)",
            old.value, new_state.value, self.call_sid,
        )

    def is_active(self) -> bool:
        return self.state == BridgeCallState.ACTIVE_CONVERSATION

    def is_awaiting_farewell(self) -> bool:
        return self.state == BridgeCallState.AWAITING_FAREWELL

    def is_closing(self) -> bool:
        return self.state == BridgeCallState.CLOSING


class SilenceTracker:
    """Track time since last caller audio activity."""

    def __init__(self) -> None:
        self._last_activity: float = asyncio.get_event_loop().time()
        self.checkin_sent: bool = False

    def mark_activity(self) -> None:
        self._last_activity = asyncio.get_event_loop().time()
        self.checkin_sent = False

    def mark_checkin_sent(self) -> None:
        self.checkin_sent = True

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
    conversation_sm = None
    booking_sm: BookingStateMachine | None = None

    try:
        # Wait for Twilio start event
        stream_sid, call_sid, caller_phone, shop_slug = await _wait_for_start(twilio_ws)

        from app.shops import get_shop_by_slug
        shop = await get_shop_by_slug(shop_slug) if shop_slug else None
        if not shop:
            logger.warning("No shop resolved from start event (slug=%r), closing", shop_slug)
            return

        logger.info("Bridge started: stream=%s call=%s shop=%s", stream_sid, call_sid, shop.slug)

        # Build call context for compositional prompt
        call_context = CallContext(
            shop_id=shop.id,
            vertical=shop.vertical_slug,
            caller_phone=caller_phone,
            today=datetime.now(timezone.utc).strftime("%Y-%m-%d %A"),
            test_mode=shop.test_mode,
        )

        # Check for resumed draft
        draft = None
        if call_sid:
            try:
                draft = await load_draft(shop.id, call_sid)
                if draft:
                    call_context.resume_draft = draft.to_dict()
                    logger.info("Resumed draft for call=%s: %s", call_sid, draft.to_dict())
            except Exception as e:
                logger.warning("Failed to load draft: %s", e)

        # Connect to Deepgram with compositional prompt
        deepgram = DeepgramAgentClient(settings.deepgram_api_key, shop, call_context)
        await deepgram.connect()

        # Initialize state machines
        from app.prompts.state_machine import StateMachine
        conversation_sm = StateMachine(call_sid=call_sid or "unknown", shop_id=shop.id)
        if draft:
            conversation_sm.current = ConversationState.SLOT_CAPTURE
        else:
            conversation_sm.transition(StateTransition.GREETING_COMPLETE, ConversationState.DISCOVERY)

        booking_sm = BookingStateMachine.start_new(
            conversation_sm, shop.id, call_sid or "unknown", caller_phone, shop.vertical_slug or "generic",
        )
        if draft:
            booking_sm.draft = draft

        call_state = BridgeCallStateTracker(call_sid=call_sid or "unknown")
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
                shop, conversation_sm, booking_sm,
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

        for task in done:
            task_name = "unknown"
            if task is twilio_task: task_name = "twilio_task"
            elif task is deepgram_task: task_name = "deepgram_task"
            elif task is farewell_task: task_name = "farewell_task"
            logger.info("asyncio.wait completed task: %s (call=%s)", task_name, call_state.call_sid)

        if farewell_task in done:
            call_state.transition_to(BridgeCallState.CLOSING)
            await asyncio.sleep(GOODBYE_DRAIN_MS / 1000)

        background_tasks = [silence_task, timeout_task]
        for task in [*pending, *background_tasks]:
            task.cancel()
        await asyncio.gather(*pending, *background_tasks, return_exceptions=True)

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

        # Save draft if booking in progress
        if booking_sm and not booking_sm.draft.is_complete and call_sid:
            try:
                await save_draft(booking_sm.draft)
                logger.info("Saved incomplete draft for call=%s", call_sid)
            except Exception as e:
                logger.warning("Failed to save draft: %s", e)

        # Log the call
        if shop is not None:
            outcome = _determine_outcome(booking_sm, transcript)
            try:
                await log_call(
                    shop_id=shop.id,
                    twilio_call_sid=call_sid,
                    started_at=started_at,
                    ended_at=ended_at,
                    transcript=transcript,
                    caller_phone=caller_phone,
                    outcome=outcome,
                )
            except Exception as e:
                logger.error("Failed to log call: %s", e)


def _determine_outcome(booking_sm: BookingStateMachine | None, transcript: str) -> str:
    if booking_sm and booking_sm.draft.is_complete:
        return "booked"
    if transcript.strip():
        return "completed"
    return "abandoned"


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
    call_state: BridgeCallStateTracker | None = None,
) -> None:
    """Forward audio from Twilio to Deepgram."""
    try:
        while True:
            raw = await twilio_ws.receive_text()
            msg = json.loads(raw)

            if msg.get("event") == "media":
                if call_state and not call_state.is_active():
                    continue
                audio_bytes = decode_twilio_media(msg)
                await deepgram.send_audio(audio_bytes)
            elif msg.get("event") == "stop":
                logger.info("_twilio_to_deepgram exiting (reason=stop event received) (call=%s)", call_state.call_sid if call_state else "?")
                return
    except WebSocketDisconnect:
        logger.info("_twilio_to_deepgram exiting (reason=WebSocketDisconnect) (call=%s)", call_state.call_sid if call_state else "?")


async def _deepgram_to_twilio(
    deepgram: DeepgramAgentClient,
    twilio_ws: WebSocket,
    stream_sid: str,
    transcript_parts: list[str],
    call_state: BridgeCallStateTracker | None = None,
    silence_tracker: SilenceTracker | None = None,
    agent_audio_done_event: asyncio.Event | None = None,
    shop: Shop | None = None,
    conversation_sm=None,
    booking_sm: BookingStateMachine | None = None,
) -> None:
    """Handle events from Deepgram and forward audio to Twilio."""
    async for event in deepgram.receive_events():
        event_type = event.get("type", "")

        if event_type == "Audio":
            twilio_msg = encode_for_twilio(event["data"], stream_sid)
            await twilio_ws.send_text(twilio_msg)

        elif event_type == "UserStartedSpeaking":
            if call_state is None or call_state.is_active():
                if silence_tracker:
                    silence_tracker.mark_activity()
            await twilio_ws.send_text(build_clear_message(stream_sid))

        elif event_type == "AgentStartedSpeaking":
            if call_state is None or call_state.is_active():
                if silence_tracker:
                    silence_tracker.mark_activity()

        elif event_type == "ConversationText":
            role = event.get("role", "unknown")
            content = event.get("content", "")
            transcript_parts.append(f"{role}: {content}")

        elif event_type == "FunctionCallRequest":
            for fn in event.get("functions", []):
                await _handle_function_call(
                    fn, deepgram, call_state, conversation_sm, booking_sm, shop, transcript_parts,
                )

        elif event_type == "AgentAudioDone":
            if call_state and call_state.is_awaiting_farewell() and agent_audio_done_event:
                logger.info("AgentAudioDone received in AWAITING_FAREWELL (call=%s)", call_state.call_sid)
                agent_audio_done_event.set()

        elif event_type in ("Error", "Warning"):
            logger.warning("Deepgram %s: %s", event_type, event.get("message", event))

    logger.info("_deepgram_to_twilio exiting (reason=deepgram websocket closed) (call=%s)", call_state.call_sid if call_state else "?")


async def _handle_function_call(
    fn: dict,
    deepgram: DeepgramAgentClient,
    call_state: BridgeCallStateTracker | None,
    conversation_sm,
    booking_sm: BookingStateMachine | None,
    shop: Shop | None,
    transcript_parts: list[str],
) -> None:
    """Process function calls from the LLM."""
    fn_name = fn.get("name", "unknown")
    fn_id = fn.get("id", "")
    client_side = fn.get("client_side", False)
    args = {}
    try:
        args = json.loads(fn.get("arguments", "{}"))
    except (json.JSONDecodeError, TypeError):
        pass

    if fn_name == "end_call" and client_side:
        confirmed = args.get("caller_confirmed_done", False)
        reason = args.get("reason", "")
        call_sid = call_state.call_sid if call_state else "?"

        if not confirmed:
            logger.warning("end_call rejected: caller_confirmed_done=false (reason=%r, call=%s)", reason, call_sid)
            await deepgram.send_function_call_response(
                fn_id, "end_call",
                '{"status": "ignored", "reason": "caller_confirmed_done must be true"}',
            )
            return

        logger.info("end_call accepted (reason=%r, call=%s)", reason, call_sid)
        await deepgram.send_function_call_response(
            fn_id, "end_call",
            '{"status": "accepted, deliver farewell now"}',
        )
        if call_state:
            call_state.transition_to(BridgeCallState.AWAITING_FAREWELL)
        if conversation_sm:
            conversation_sm.transition(StateTransition.CALLER_DONE, ConversationState.FAREWELL)
        return

    if fn_name == "check_availability":
        service = args.get("service", "")
        date_str = args.get("date", "")
        time_str = args.get("time", "")
        logger.info("check_availability: %s %s %s (call=%s)", service, date_str, time_str, call_state.call_sid if call_state else "?")

        if shop and conversation_sm:
            conversation_sm.transition(StateTransition.SLOT_PROPOSED, ConversationState.SLOT_CAPTURE)

        # Simple response for now — full implementation would query calendar
        await deepgram.send_function_call_response(
            fn_id, "check_availability",
            json.dumps({"available": True, "message": f"{date_str} at {time_str} is available."}),
        )
        return

    if fn_name == "book_appointment":
        service = args.get("service", "")
        date_str = args.get("date", "")
        time_str = args.get("time", "")
        customer_name = args.get("customer_name", "")
        customer_phone = args.get("customer_phone", "")
        notes = args.get("notes", "")

        logger.info("book_appointment: %s for %s on %s %s (call=%s)", service, customer_name, date_str, time_str, call_state.call_sid if call_state else "?")

        if shop and booking_sm:
            try:
                from datetime import datetime
                scheduled_at = datetime.fromisoformat(f"{date_str}T{time_str}")
                booking = await atomic_book(
                    shop=shop,
                    service=service,
                    start=scheduled_at,
                    customer_name=customer_name,
                    customer_phone=customer_phone,
                    notes=notes,
                    test_mode=shop.test_mode,
                )
                await deepgram.send_function_call_response(
                    fn_id, "book_appointment",
                    json.dumps({"status": "booked", "booking_id": booking.get("id"), "message": "Appointment confirmed."}),
                )

                # Transition conversation state
                if conversation_sm:
                    conversation_sm.transition(StateTransition.BOOKING_FINALIZED, ConversationState.FAREWELL)

                # Send owner alert
                await send_owner_alert(shop, "first_time_customer" if True else "all_bookings", {
                    "customer_name": customer_name,
                    "service": service,
                    "scheduled_at": f"{date_str} {time_str}",
                })

                # Send customer confirmation SMS
                if customer_phone:
                    from app.sms.templates import render_confirmation
                    body = render_confirmation(shop, service, f"{date_str} at {time_str}")
                    await send_sms(customer_phone, body)

            except BookingConflictError as e:
                await deepgram.send_function_call_response(
                    fn_id, "book_appointment",
                    json.dumps({"status": "conflict", "message": str(e)}),
                )
            except CalendarWriteError as e:
                await deepgram.send_function_call_response(
                    fn_id, "book_appointment",
                    json.dumps({"status": "error", "message": str(e)}),
                )
                if shop:
                    await create_decision(
                        shop_id=shop.id,
                        decision_type="connect_calendar",
                        title="Calendar connection failed",
                        body=f"Could not write booking to Google Calendar: {e}",
                        context={"call_sid": call_state.call_sid if call_state else None},
                    )
            except Exception as e:
                logger.error("book_appointment failed: %s", e)
                await deepgram.send_function_call_response(
                    fn_id, "book_appointment",
                    json.dumps({"status": "error", "message": "Internal error. Please try again."}),
                )
        else:
            await deepgram.send_function_call_response(
                fn_id, "book_appointment",
                json.dumps({"status": "error", "message": "Shop not available."}),
            )
        return

    if fn_name == "collect_slot":
        slot_name = args.get("slot_name", "")
        value = args.get("value", "")
        if booking_sm:
            ok, err = booking_sm.handle_slot_extracted(slot_name, value)
            await deepgram.send_function_call_response(
                fn_id, "collect_slot",
                json.dumps({"ok": ok, "error": err, "pending_slot": booking_sm.draft.pending_slot_name}),
            )
        else:
            await deepgram.send_function_call_response(
                fn_id, "collect_slot",
                json.dumps({"ok": False, "error": "No active booking"}),
            )
        return

    if fn_name == "confirm_slot":
        slot_name = args.get("slot_name", "")
        if booking_sm:
            booking_sm.handle_slot_confirmed(slot_name)
            await deepgram.send_function_call_response(
                fn_id, "confirm_slot",
                json.dumps({"ok": True, "is_complete": booking_sm.draft.is_complete, "pending_slot": booking_sm.draft.pending_slot_name}),
            )
        else:
            await deepgram.send_function_call_response(
                fn_id, "confirm_slot",
                json.dumps({"ok": False, "error": "No active booking"}),
            )
        return

    if fn_name == "reject_slot":
        slot_name = args.get("slot_name", "")
        if booking_sm:
            booking_sm.handle_slot_rejected(slot_name)
            await deepgram.send_function_call_response(
                fn_id, "reject_slot",
                json.dumps({"ok": True, "pending_slot": booking_sm.draft.pending_slot_name}),
            )
        else:
            await deepgram.send_function_call_response(
                fn_id, "reject_slot",
                json.dumps({"ok": False, "error": "No active booking"}),
            )
        return

    logger.warning("Unhandled FunctionCallRequest: %s (client_side=%s)", fn_name, client_side)


async def _farewell_safety_watchdog(
    call_state: BridgeCallStateTracker,
    deepgram: DeepgramAgentClient,
    shop: Shop,
    agent_audio_done_event: asyncio.Event,
) -> None:
    """Wait for LLM farewell to finish; inject fallback if safety timeout fires."""
    while not call_state.is_awaiting_farewell():
        if call_state.is_closing():
            logger.info("_farewell_safety_watchdog exiting (reason=state was already closing) (call=%s)", call_state.call_sid)
            return
        await asyncio.sleep(0.2)

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
    call_state: BridgeCallStateTracker | None = None,
) -> None:
    """If no caller audio for SILENCE_TIMEOUT seconds, transition to farewell."""
    while True:
        await asyncio.sleep(5)
        if not (call_state is None or call_state.is_active()):
            continue
        elapsed = silence_tracker.elapsed()
        if elapsed >= SILENCE_CHECKIN_THRESHOLD and not silence_tracker.checkin_sent and (call_state is None or call_state.is_active()):
            call_sid = call_state.call_sid if call_state else "?"
            logger.info("Silence checkin sent at %ds (call=%s)", SILENCE_CHECKIN_THRESHOLD, call_sid)
            await deepgram.inject_goodbye("Take your time.")
            silence_tracker.mark_checkin_sent()
        if elapsed >= SILENCE_TIMEOUT:
            call_sid = call_state.call_sid if call_state else "?"
            logger.info("Silence timeout (%ds) reached, ending call (call=%s)", SILENCE_TIMEOUT, call_sid)
            if call_state:
                call_state.transition_to(BridgeCallState.AWAITING_FAREWELL)
            farewell_msg = shop.farewell if shop else None
            await deepgram.inject_goodbye(farewell_msg)
            continue


async def _call_timeout(
    seconds: int,
    twilio_ws: WebSocket,
    deepgram: DeepgramAgentClient,
    stream_sid: str | None,
    call_state: BridgeCallStateTracker | None = None,
) -> None:
    """Enforce max call duration. Runs until cancelled."""
    await asyncio.sleep(seconds)
    call_sid = call_state.call_sid if call_state else "?"
    logger.info("Call reached %ds limit, closing (call=%s)", seconds, call_sid)

    try:
        if call_state:
            call_state.transition_to(BridgeCallState.AWAITING_FAREWELL)
        await deepgram.inject_goodbye()
    except Exception as e:
        logger.warning("Could not send goodbye: %s", e)

    while True:
        await asyncio.sleep(5)
