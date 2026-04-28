"""Booking sub-state-machine: tracks slot capture within the SCHEDULING/SLOT_CAPTURE conversation state."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from app.booking.slots import get_slots_for_vertical, SLOT_VALIDATORS
from app.prompts.state_machine import ConversationState, StateMachine, StateTransition

logger = logging.getLogger(__name__)


@dataclass
class SlotDefinition:
    name: str
    required: bool
    type: str
    options: list[str] = field(default_factory=list)
    min_len: int = 1


@dataclass
class BookingDraft:
    """In-progress booking state."""

    shop_id: str
    call_sid: str
    caller_phone: str | None
    vertical_slug: str
    slots: list[SlotDefinition] = field(default_factory=list)
    captured: dict[str, Any] = field(default_factory=dict)
    confirmed: dict[str, bool] = field(default_factory=dict)
    current_slot_index: int = 0
    state: str = "slot_capture"

    @property
    def current_slot(self) -> SlotDefinition | None:
        if 0 <= self.current_slot_index < len(self.slots):
            return self.slots[self.current_slot_index]
        return None

    @property
    def is_complete(self) -> bool:
        for slot in self.slots:
            if slot.required and not self.confirmed.get(slot.name, False):
                return False
        return True

    @property
    def pending_slot_name(self) -> str | None:
        slot = self.current_slot
        return slot.name if slot else None

    def set_slot_value(self, name: str, value: Any) -> tuple[bool, str]:
        """Attempt to set a slot value. Returns (ok, error_message)."""
        slot = next((s for s in self.slots if s.name == name), None)
        if not slot:
            return False, f"Unknown slot: {name}"

        validator_factory = SLOT_VALIDATORS.get(slot.type)
        if validator_factory:
            validator = validator_factory(options=slot.options, min_len=slot.min_len)
            ok, err = validator(value)
            if not ok:
                return False, err

        self.captured[name] = value
        return True, ""

    def confirm_slot(self, name: str) -> None:
        self.confirmed[name] = True
        # Advance to next unconfirmed required slot
        for i, slot in enumerate(self.slots):
            if slot.required and not self.confirmed.get(slot.name):
                self.current_slot_index = i
                return
        self.current_slot_index = len(self.slots)

    def reject_slot(self, name: str) -> None:
        self.confirmed.pop(name, None)
        self.captured.pop(name, None)
        # Reset index to this slot
        for i, slot in enumerate(self.slots):
            if slot.name == name:
                self.current_slot_index = i
                return

    def to_dict(self) -> dict[str, Any]:
        return {
            "shop_id": self.shop_id,
            "call_sid": self.call_sid,
            "caller_phone": self.caller_phone,
            "vertical_slug": self.vertical_slug,
            "captured_slots": self.captured,
            "confirmed_slots": self.confirmed,
            "pending_slot": self.pending_slot_name,
            "state": self.state,
            "is_complete": self.is_complete,
        }


class BookingStateMachine:
    """Orchestrates slot capture within a conversation."""

    def __init__(
        self,
        conversation_sm: StateMachine,
        draft: BookingDraft,
    ) -> None:
        self.conversation = conversation_sm
        self.draft = draft

    @classmethod
    def start_new(
        cls,
        conversation_sm: StateMachine,
        shop_id: str,
        call_sid: str,
        caller_phone: str | None,
        vertical_slug: str,
    ) -> "BookingStateMachine":
        slots_data = get_slots_for_vertical(vertical_slug)
        slots = [
            SlotDefinition(
                name=s["name"],
                required=s.get("required", True),
                type=s.get("type", "text"),
                options=s.get("options", []),
                min_len=s.get("min_len", 1),
            )
            for s in slots_data
        ]
        draft = BookingDraft(
            shop_id=shop_id,
            call_sid=call_sid,
            caller_phone=caller_phone,
            vertical_slug=vertical_slug,
            slots=slots,
        )
        return cls(conversation_sm, draft)

    def handle_slot_extracted(self, name: str, value: Any) -> tuple[bool, str]:
        """Process an extracted slot value from the LLM."""
        ok, err = self.draft.set_slot_value(name, value)
        if not ok:
            return False, err

        self._emit_event("slot_extracted", {"slot": name, "value": value})
        return True, ""

    def handle_slot_confirmed(self, name: str) -> bool:
        """Caller confirmed the slot value (e.g., phone number repeated back)."""
        if name not in self.draft.captured:
            return False
        self.draft.confirm_slot(name)
        self._emit_event("slot_confirmed", {"slot": name})

        if self.draft.is_complete:
            self.conversation.transition(
                StateTransition.ALL_SLOTS_CAPTURED,
                ConversationState.CONFIRMING,
            )
        return True

    def handle_slot_rejected(self, name: str) -> None:
        """Caller rejected the slot value; re-collect."""
        self.draft.reject_slot(name)
        self._emit_event("slot_rejected", {"slot": name})

    def _emit_event(self, event_type: str, payload: dict) -> None:
        from app.supabase_client import get_supabase
        try:
            get_supabase().table("call_events").insert({
                "call_sid": self.draft.call_sid,
                "event_type": event_type,
                "payload_json": payload,
            }).execute()
        except Exception as e:
            logger.warning("Failed to emit booking event: %s", e)
