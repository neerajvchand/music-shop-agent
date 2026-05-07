"""Regression tests for call_events shop_id propagation.

Two paths emit call_events rows:
  - app/booking/state.py BookingStateMachine._emit_event (slot_extracted, etc.)
  - app/prompts/state_machine.py _persist_event (state transitions)

Both must include shop_id. Empty/missing shop_id must NOT result in an insert
with a placeholder string.
"""

from unittest.mock import MagicMock, patch

from app.booking.state import BookingDraft, BookingStateMachine
from app.prompts import state_machine
from app.prompts.state_machine import (
    ConversationState,
    StateMachine,
    StateTransition,
)


def _captured_payload(insert_mock: MagicMock) -> dict:
    """Pull the payload dict out of `.table('call_events').insert(<payload>).execute()`."""
    args, _ = insert_mock.call_args
    return args[0]


def _make_bsm(shop_id: str, call_sid: str = "CAtest") -> BookingStateMachine:
    """Build a BookingStateMachine without start_new() so no Supabase fetch fires."""
    draft = BookingDraft(
        shop_id=shop_id,
        call_sid=call_sid,
        caller_phone="+15555550000",
        vertical_slug="music_lessons",
        slots=[],
    )
    conversation = StateMachine(call_sid=call_sid, shop_id=shop_id)
    return BookingStateMachine(conversation, draft)


def test_booking_emit_event_includes_shop_id():
    """slot_extracted must carry shop_id from the BookingDraft."""
    bsm = _make_bsm(shop_id="shop-uuid-1")

    fake_supabase = MagicMock()
    insert_mock = fake_supabase.table.return_value.insert
    insert_mock.return_value.execute.return_value = MagicMock(data=[])

    with patch("app.supabase_client.get_supabase", return_value=fake_supabase):
        bsm._emit_event("slot_extracted", {"slot": "student_name", "value": "Test"})

    fake_supabase.table.assert_called_with("call_events")
    payload = _captured_payload(insert_mock)
    assert payload["shop_id"] == "shop-uuid-1", payload
    assert payload["call_sid"] == "CAtest"
    assert payload["event_type"] == "slot_extracted"
    assert payload["payload_json"] == {"slot": "student_name", "value": "Test"}


def test_persist_event_drops_when_shop_id_missing(caplog):
    """_persist_event must NOT insert a placeholder when shop_id is empty."""
    fake_supabase = MagicMock()

    with caplog.at_level("ERROR", logger="app.prompts.state_machine"):
        with patch("app.supabase_client.get_supabase", return_value=fake_supabase):
            state_machine._persist_event(
                call_sid="CAtest",
                shop_id="",
                transition=StateTransition.GREETING_COMPLETE,
                target=ConversationState.DISCOVERY,
            )

    fake_supabase.table.assert_not_called()
    assert any(
        "without shop_id" in rec.message for rec in caplog.records
    ), [r.message for r in caplog.records]


def test_persist_event_drops_when_shop_id_whitespace(caplog):
    fake_supabase = MagicMock()
    with caplog.at_level("ERROR", logger="app.prompts.state_machine"):
        with patch("app.supabase_client.get_supabase", return_value=fake_supabase):
            state_machine._persist_event(
                call_sid="CAtest",
                shop_id="   ",
                transition=StateTransition.GREETING_COMPLETE,
                target=ConversationState.DISCOVERY,
            )
    fake_supabase.table.assert_not_called()


def test_persist_event_inserts_when_shop_id_present():
    fake_supabase = MagicMock()
    insert_mock = fake_supabase.table.return_value.insert
    insert_mock.return_value.execute.return_value = MagicMock(data=[])

    with patch("app.supabase_client.get_supabase", return_value=fake_supabase):
        state_machine._persist_event(
            call_sid="CAtest",
            shop_id="shop-uuid-2",
            transition=StateTransition.GREETING_COMPLETE,
            target=ConversationState.DISCOVERY,
        )

    fake_supabase.table.assert_called_with("call_events")
    payload = _captured_payload(insert_mock)
    assert payload["shop_id"] == "shop-uuid-2"
    assert "unknown" not in str(payload).lower()
