"""Renderer unit tests — natural-language output, settings-driven."""

from app.prompts import renderers


def test_business_hours_groups_consecutive_days():
    hours = {
        "monday": None,
        "tuesday": {"open": "10:00", "close": "19:00"},
        "wednesday": {"open": "10:00", "close": "19:00"},
        "thursday": {"open": "10:00", "close": "19:00"},
        "friday": {"open": "10:00", "close": "19:00"},
        "saturday": {"open": "10:00", "close": "19:00"},
        "sunday": None,
    }
    out = renderers.render_business_hours(hours)
    assert "Tuesday through Saturday from 10am to 7pm" in out
    assert "Closed" in out
    assert "Sundays" in out and "Mondays" in out


def test_business_hours_handles_split_groups():
    hours = {
        "monday": {"open": "09:00", "close": "12:00"},
        "tuesday": {"open": "13:00", "close": "17:00"},
        "wednesday": None,
        "thursday": None,
        "friday": None,
        "saturday": None,
        "sunday": None,
    }
    out = renderers.render_business_hours(hours)
    assert "Monday from 9am to 12pm" in out
    assert "Tuesday from 1pm to 5pm" in out


def test_business_hours_handles_malformed():
    assert renderers.render_business_hours("not json") == ""
    assert renderers.render_business_hours(None) == ""
    assert renderers.render_business_hours({"monday": "broken"}) != ""  # treated as closed


def test_services_collapses_trial_and_regular():
    services = [
        {"id": "tabla_lesson_trial", "name": "Tabla Lesson (Trial)", "duration_min": 30, "price": 50, "active": True, "instructor": "Happy Singh", "mode": "both", "is_lesson": True},
        {"id": "tabla_lesson", "name": "Tabla Lesson", "duration_min": 45, "price": 75, "active": True, "instructor": "Happy Singh", "mode": "both", "is_lesson": True},
    ]
    out = renderers.render_services(services)
    assert "Tabla Lesson with Happy Singh" in out
    assert "30 or 45 minutes" in out
    assert "50" in out and "75" in out
    assert "Trial" not in out  # never spoken aloud per guardrail


def test_services_separates_lessons_from_other():
    services = [
        {"id": "tabla", "name": "Tabla Lesson", "duration_min": 45, "price": 75, "active": True, "instructor": "Happy Singh", "is_lesson": True},
        {"id": "showroom", "name": "Showroom Visit", "duration_min": 30, "price": 0, "active": True, "is_lesson": False},
    ]
    out = renderers.render_services(services)
    assert out.startswith("Lessons:")
    assert "Other services:" in out
    assert "Showroom Visit" in out


def test_services_skips_inactive():
    services = [
        {"id": "a", "name": "Active", "duration_min": 30, "active": True},
        {"id": "b", "name": "Inactive", "duration_min": 30, "active": False},
    ]
    out = renderers.render_services(services)
    assert "Active" in out
    assert "Inactive" not in out


def test_rentals_disabled_returns_empty():
    out = renderers.render_rentals({"short_term": {"enabled": False}, "monthly_student": {"enabled": False}})
    assert out == ""


def test_rentals_both_enabled():
    out = renderers.render_rentals({
        "short_term": {"enabled": True, "day_rate": 75, "deposit": 500},
        "monthly_student": {"enabled": True, "rate": 150},
    })
    assert "$75 per day" in out
    assert "$500 deposit" in out
    assert "$150 per month" in out


def test_cancellation_disabled_returns_empty():
    assert renderers.render_cancellation_policy({"enabled": False}) == ""


def test_cancellation_enabled_renders_policy():
    out = renderers.render_cancellation_policy({"enabled": True, "hours_before": 48, "percent_charge": 50})
    assert "48-hour" in out
    assert "50%" in out


def test_payment_portal_speaks_naturally_not_url():
    out = renderers.render_payment_portal({"url": "https://riyaaz.com/pay", "mention_autopay": True})
    assert "on our website" in out
    assert "riyaaz.com" not in out
    assert "autopay" in out


def test_payment_portal_no_url_with_autopay():
    out = renderers.render_payment_portal({"url": None, "mention_autopay": True})
    assert "online portal" in out
    assert "autopay" in out


def test_payment_portal_neither_returns_empty():
    assert renderers.render_payment_portal({"url": None, "mention_autopay": False}) == ""


def test_escalation_disabled_returns_empty():
    assert renderers.render_escalation({"live_person_callback": False}) == ""


def test_escalation_enabled_uses_sla_text():
    out = renderers.render_escalation({"live_person_callback": True, "callback_sla_text": "within an hour"})
    assert "within an hour" in out


def test_talent_on_tour_route_modes():
    talent = {
        "instructors": [
            {"instructor_name": "Sandip Ghosh", "status": "visiting",
             "description": "a visiting tabla maestro",
             "route_to": "start_with_other_instructor"},
        ],
    }
    out = renderers.render_talent_on_tour(talent)
    assert "Sandip Ghosh" in out
    assert "another instructor" in out
    assert "Sandip is in session again" in out


def test_talent_callback_only():
    out = renderers.render_talent_on_tour({
        "instructors": [{
            "instructor_name": "Sandip Ghosh",
            "description": "a visiting tabla maestro",
            "route_to": "callback_only",
        }],
    })
    assert "follow up" in out
    assert "another instructor" not in out


def test_age_policy_soft():
    out = renderers.render_age_policy({"minimum_age": 5, "mode": "soft"})
    assert "around age 5" in out
    assert "if they're able to focus" in out


def test_age_policy_hard():
    out = renderers.render_age_policy({"minimum_age": 8, "mode": "hard"})
    assert "age 8" in out
    assert "focus" not in out


def test_age_policy_zero_returns_empty():
    assert renderers.render_age_policy({"minimum_age": 0, "mode": "soft"}) == ""


def test_languages_renders_instruction_text():
    out = renderers.render_languages({"mirrors": [
        {"trigger": "Namaste", "response": "Namaste"},
        {"trigger": "Sat Sri Akaal", "response": "Sat Sri Akaal"},
    ]})
    assert "Namaste" in out
    assert "Sat Sri Akaal" in out
    assert "continue in English" in out


def test_languages_empty_list_returns_empty():
    assert renderers.render_languages({"mirrors": []}) == ""
