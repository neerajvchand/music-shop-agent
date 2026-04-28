"""Formal conversation state machine for the voice agent."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

logger = logging.getLogger(__name__)


class ConversationState(str, Enum):
    """Primary conversation states."""

    GREETING = "greeting"
    DISCOVERY = "discovery"
    SCHEDULING = "scheduling"
    SLOT_CAPTURE = "slot_capture"
    CONFIRMING = "confirming"
    FAREWELL = "farewell"

    # Side-state reachable from anywhere
    RECOVERY = "recovery"


class StateTransition(str, Enum):
    """Named transitions that emit events."""

    GREETING_COMPLETE = "greeting_complete"
    CALLER_INTENT_KNOWN = "caller_intent_known"
    SCHEDULING_STARTED = "scheduling_started"
    SLOT_PROPOSED = "slot_proposed"
    SLOT_ACCEPTED = "slot_accepted"
    ALL_SLOTS_CAPTURED = "all_slots_captured"
    CONFIRMATION_RECEIVED = "confirmation_received"
    CONFIRMATION_REJECTED = "confirmation_rejected"
    BOOKING_FINALIZED = "booking_finalized"
    CALLER_DONE = "caller_done"
    CALLER_DISCONNECTED = "caller_disconnected"
    SILENCE_TIMEOUT = "silence_timeout"
    MAX_DURATION_REACHED = "max_duration_reached"
    RECOVERY_TRIGGERED = "recovery_triggered"
    RECOVERY_RESOLVED = "recovery_resolved"


# Valid state transitions
_TRANSITION_MAP: dict[ConversationState, list[ConversationState]] = {
    ConversationState.GREETING: [
        ConversationState.DISCOVERY,
        ConversationState.RECOVERY,
    ],
    ConversationState.DISCOVERY: [
        ConversationState.SCHEDULING,
        ConversationState.FAREWELL,
        ConversationState.RECOVERY,
    ],
    ConversationState.SCHEDULING: [
        ConversationState.SLOT_CAPTURE,
        ConversationState.FAREWELL,
        ConversationState.RECOVERY,
    ],
    ConversationState.SLOT_CAPTURE: [
        ConversationState.CONFIRMING,
        ConversationState.SLOT_CAPTURE,  # loop on repair
        ConversationState.FAREWELL,
        ConversationState.RECOVERY,
    ],
    ConversationState.CONFIRMING: [
        ConversationState.FAREWELL,
        ConversationState.SLOT_CAPTURE,  # back to repair
        ConversationState.RECOVERY,
    ],
    ConversationState.FAREWELL: [
        ConversationState.FAREWELL,  # stay until audio done
    ],
    ConversationState.RECOVERY: [
        ConversationState.DISCOVERY,
        ConversationState.SCHEDULING,
        ConversationState.SLOT_CAPTURE,
        ConversationState.FAREWELL,
    ],
}


@dataclass
class StateMachine:
    """Tracks current state and emits transition events."""

    call_sid: str
    current: ConversationState = field(default=ConversationState.GREETING)
    history: list[tuple[datetime, StateTransition, ConversationState]] = field(
        default_factory=list
    )

    def can_transition(self, target: ConversationState) -> bool:
        return target in _TRANSITION_MAP.get(self.current, [])

    def transition(self, transition: StateTransition, target: ConversationState) -> None:
        if not self.can_transition(target):
            logger.warning(
                "Unusual state transition: %s -> %s (call=%s)",
                self.current.value, target.value, self.call_sid,
            )
        else:
            logger.info(
                "State transition: %s -> %s via %s (call=%s)",
                self.current.value, target.value, transition.value, self.call_sid,
            )

        self.history.append((datetime.now(timezone.utc), transition, target))
        self.current = target

        # Persist event asynchronously (fire-and-forget)
        try:
            _persist_event(self.call_sid, transition, target)
        except Exception as e:
            logger.warning("Failed to persist state event: %s", e)

    def current_module_name(self) -> str:
        """Return the prompt module name for the current state."""
        if self.current == ConversationState.SLOT_CAPTURE:
            return "slot_capture"
        if self.current == ConversationState.RECOVERY:
            return "recovery"
        return f"state_{self.current.value}"


def _persist_event(call_sid: str, transition: StateTransition, target: ConversationState) -> None:
    """Write transition to call_events table."""
    from app.supabase_client import get_supabase

    get_supabase().table("call_events").insert({
        "call_sid": call_sid,
        "event_type": "state_transition",
        "payload_json": {
            "transition": transition.value,
            "to_state": target.value,
        },
    }).execute()
