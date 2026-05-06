"""Composer tests — proves the Settings → prompt pipeline end-to-end.

This is the programmatic equivalent of the live phone gate. If these tests
pass, the templating path works: changing a value on the Shop row changes the
rendered prompt the agent sees on the next call.
"""

from unittest.mock import patch

from app.prompts import composer
from app.prompts.composer import CallContext, build_call_context_from_shop, compose


class _FakeShop:
    def __init__(self, **kw):
        defaults = dict(
            id="shop-1",
            name="Test Music Shop",
            vertical_slug="music_lessons",
            test_mode=True,
            public_phone="510-555-1234",
            owner_phone="+15105550000",
            address="123 Test St",
            greeting="Thank you for calling Test Music Shop. How can I help you today?",
            business_hours_json={
                "monday": None,
                "tuesday": {"open": "10:00", "close": "19:00"},
                "wednesday": {"open": "10:00", "close": "19:00"},
                "thursday": {"open": "10:00", "close": "19:00"},
                "friday": {"open": "10:00", "close": "19:00"},
                "saturday": {"open": "10:00", "close": "19:00"},
                "sunday": None,
            },
            services_json=[
                {"id": "tabla", "name": "Tabla Lesson", "duration_min": 45,
                 "price": 75, "active": True, "instructor": "Happy Singh", "is_lesson": True},
            ],
            languages_json={"mirrors": [{"trigger": "Namaste", "response": "Namaste"}]},
            rentals_json={"short_term": {"enabled": True, "day_rate": 75, "deposit": 500},
                          "monthly_student": {"enabled": False}},
            cancellation_policy_json={"enabled": True, "hours_before": 48, "percent_charge": 50},
            payment_portal_json={"url": None, "mention_autopay": True},
            escalation_json={"live_person_callback": True, "callback_sla_text": "shortly"},
            talent_on_tour_json={"instructors": []},
            age_policy_json={"minimum_age": 5, "mode": "soft"},
        )
        defaults.update(kw)
        for k, v in defaults.items():
            setattr(self, k, v)


def test_build_call_context_hydrates_all_fields():
    shop = _FakeShop()
    ctx = build_call_context_from_shop(shop, caller_phone="+15555551212", today="2026-05-06 Wednesday")
    assert ctx.shop_name == "Test Music Shop"
    assert ctx.shop_phone == "510-555-1234"
    assert ctx.shop_address == "123 Test St"
    assert "Tuesday through Saturday" in ctx.business_hours_text
    assert "Tabla Lesson" in ctx.services_text
    assert "Namaste" in ctx.languages_text
    assert "$75 per day" in ctx.rentals_text
    assert "48-hour" in ctx.cancellation_policy_text
    assert "autopay" in ctx.payment_portal_text
    assert "follow up" in ctx.escalation_text
    assert "around age 5" in ctx.age_policy_text
    assert ctx.greeting == "Thank you for calling Test Music Shop. How can I help you today?"


def test_build_falls_back_to_owner_phone_when_no_public_phone():
    shop = _FakeShop(public_phone=None)
    ctx = build_call_context_from_shop(shop, caller_phone=None, today="")
    assert ctx.shop_phone == "+15105550000"


def test_compose_substitutes_placeholders_into_module_content():
    """Critical: `{{placeholder}}` in module content gets replaced by the
    matching CallContext field. This is the exact path that drives Settings
    → live prompt."""
    bindings = [{"module_name": "business", "module_version": 1, "vertical_slug": "music_lessons"}]
    fake_module = {
        "name": "business",
        "version": 1,
        "vertical_slug": "music_lessons",
        "content": "Phone: {{shop_phone}}\nHours: {{business_hours_text}}\nGreeting: {{greeting}}",
        "params_schema": {
            "type": "object",
            "properties": {
                "shop_phone": {"type": "string"},
                "business_hours_text": {"type": "string"},
                "greeting": {"type": "string"},
            },
        },
        "status": "live",
    }
    ctx = build_call_context_from_shop(_FakeShop(), caller_phone=None, today="")

    with patch.object(composer.PromptRegistry, "get_module", return_value=fake_module):
        rendered, _tools = compose(ctx, bindings=bindings)

    assert "Phone: 510-555-1234" in rendered
    assert "Tuesday through Saturday" in rendered
    assert "Thank you for calling Test Music Shop" in rendered
    # Critical: the literal placeholder string never survives.
    assert "{{shop_phone}}" not in rendered
    assert "{{business_hours_text}}" not in rendered


def test_compose_strips_unsubstituted_placeholders():
    """If a module references a placeholder that's not on CallContext, the
    composer must NOT let it leak into the prompt the agent reads."""
    bindings = [{"module_name": "business", "module_version": 1, "vertical_slug": "music_lessons"}]
    fake_module = {
        "name": "business",
        "version": 1,
        "vertical_slug": "music_lessons",
        "content": "Mystery: {{nonexistent_field}}",
        "params_schema": {"type": "object", "properties": {"nonexistent_field": {"type": "string"}}},
        "status": "live",
    }
    ctx = build_call_context_from_shop(_FakeShop(), caller_phone=None, today="")
    with patch.object(composer.PromptRegistry, "get_module", return_value=fake_module):
        rendered, _ = compose(ctx, bindings=bindings)
    assert "{{nonexistent_field}}" not in rendered


def test_compose_changes_when_settings_change():
    """The end-to-end claim: edit a shop setting, the next compose() reflects
    it. Two calls to compose() with two shop states must produce different
    output for that field."""
    bindings = [{"module_name": "business", "module_version": 1, "vertical_slug": "music_lessons"}]
    fake_module = {
        "name": "business",
        "version": 1,
        "vertical_slug": "music_lessons",
        "content": "Phone: {{shop_phone}}",
        "params_schema": {"type": "object", "properties": {"shop_phone": {"type": "string"}}},
        "status": "live",
    }

    ctx_v1 = build_call_context_from_shop(_FakeShop(public_phone="510-111-1111"), caller_phone=None, today="")
    ctx_v2 = build_call_context_from_shop(_FakeShop(public_phone="510-222-2222"), caller_phone=None, today="")

    with patch.object(composer.PromptRegistry, "get_module", return_value=fake_module):
        out_v1, _ = compose(ctx_v1, bindings=bindings)
        out_v2, _ = compose(ctx_v2, bindings=bindings)

    assert "510-111-1111" in out_v1
    assert "510-222-2222" in out_v2
    assert out_v1 != out_v2


def test_compose_handles_disabled_settings_gracefully():
    """When a setting is disabled (e.g., rentals off, escalation off), the
    rendered text is empty and the prompt simply omits the line — not a
    literal empty placeholder."""
    bindings = [{"module_name": "vertical", "module_version": 1, "vertical_slug": "music_lessons"}]
    fake_module = {
        "name": "vertical",
        "version": 1,
        "vertical_slug": "music_lessons",
        "content": "RENTALS:\n{{rentals_text}}\n\nESCALATION:\n{{escalation_text}}",
        "params_schema": {"type": "object", "properties": {
            "rentals_text": {"type": "string"},
            "escalation_text": {"type": "string"},
        }},
        "status": "live",
    }

    shop = _FakeShop(
        rentals_json={"short_term": {"enabled": False}, "monthly_student": {"enabled": False}},
        escalation_json={"live_person_callback": False},
    )
    ctx = build_call_context_from_shop(shop, caller_phone=None, today="")

    with patch.object(composer.PromptRegistry, "get_module", return_value=fake_module):
        rendered, _ = compose(ctx, bindings=bindings)

    # Both sections present (their headings remain) but the values are empty.
    assert "RENTALS:" in rendered
    assert "ESCALATION:" in rendered
    assert "{{" not in rendered
