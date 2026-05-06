"""Pure renderers — turn shop settings JSON into natural-language prompt text.

Each function takes raw settings data and returns a string that drops directly
into a `{{placeholder}}` slot. All functions are pure: no DB calls, no
side effects, no exceptions on malformed input — they log and return "".

The agent's voice quality depends on these strings reading naturally when
spoken aloud. Prefer "on our website" over a literal URL, "Tuesday through
Saturday from 10am to 7pm" over "Tue–Sat 10:00–19:00", and so on.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


_DAYS_ORDERED = [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]
_DAY_TITLE = {d: d.capitalize() for d in _DAYS_ORDERED}


def _safe(fn_name: str, fn, default: str = "") -> str:
    try:
        out = fn()
        return out if isinstance(out, str) else default
    except Exception as e:
        logger.warning("renderer %s failed: %s", fn_name, e)
        return default


def _coerce(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value
    return value


# ---------- business hours ----------

def _format_clock(hhmm: str) -> str:
    h, m = hhmm.split(":")
    hour = int(h)
    minute = int(m)
    suffix = "am" if hour < 12 else "pm"
    display_hour = hour % 12 or 12
    if minute == 0:
        return f"{display_hour}{suffix}"
    return f"{display_hour}:{minute:02d}{suffix}"


def render_business_hours(hours_json: Any) -> str:
    return _safe("render_business_hours", lambda: _render_business_hours_inner(hours_json))


def _render_business_hours_inner(hours_json: Any) -> str:
    if hours_json is None:
        return ""
    hours = _coerce(hours_json) or {}
    if not isinstance(hours, dict) or not hours:
        return ""

    open_days: list[tuple[str, str, str]] = []  # (day, open, close)
    closed_days: list[str] = []
    for day in _DAYS_ORDERED:
        entry = hours.get(day)
        if entry is None:
            closed_days.append(day)
        elif isinstance(entry, dict) and "open" in entry and "close" in entry:
            open_days.append((day, entry["open"], entry["close"]))
        else:
            closed_days.append(day)

    # Group consecutive open days that share the same hours
    groups: list[list[tuple[str, str, str]]] = []
    for entry in open_days:
        if groups and groups[-1][-1][1] == entry[1] and groups[-1][-1][2] == entry[2]:
            prev_idx = _DAYS_ORDERED.index(groups[-1][-1][0])
            this_idx = _DAYS_ORDERED.index(entry[0])
            if this_idx == prev_idx + 1:
                groups[-1].append(entry)
                continue
        groups.append([entry])

    open_phrases: list[str] = []
    for group in groups:
        first_day = _DAY_TITLE[group[0][0]]
        last_day = _DAY_TITLE[group[-1][0]]
        open_t = _format_clock(group[0][1])
        close_t = _format_clock(group[0][2])
        if len(group) == 1:
            open_phrases.append(f"{first_day} from {open_t} to {close_t}")
        else:
            open_phrases.append(f"{first_day} through {last_day} from {open_t} to {close_t}")

    parts: list[str] = []
    if open_phrases:
        parts.append("We are open " + _join_natural(open_phrases) + ".")
    if closed_days:
        closed_pretty = [f"{_DAY_TITLE[d]}s" for d in closed_days]
        parts.append("Closed " + _join_natural(closed_pretty) + ".")
    return " ".join(parts)


def _join_natural(items: list[str]) -> str:
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return ", ".join(items[:-1]) + ", and " + items[-1]


# ---------- services ----------

def render_services(services_json: Any) -> str:
    return _safe("render_services", lambda: _render_services_inner(services_json))


def _strip_trial(name: str) -> str:
    # The data layer keeps "(Trial)" / "Trial" in service names so legacy IDs
    # and analytics don't break. The spoken layer never says "trial" — see the
    # corresponding guardrail rule. Strip it here.
    cleaned = name
    for token in [" (Trial)", "(Trial)", " Trial", "Trial"]:
        cleaned = cleaned.replace(token, "")
    return cleaned.strip()


def _service_field(svc: dict, *names, default=None):
    for n in names:
        if n in svc and svc[n] is not None:
            return svc[n]
    return default


def _render_services_inner(services_json: Any) -> str:
    services = _coerce(services_json) or []
    if not isinstance(services, list):
        return ""

    active = [s for s in services if isinstance(s, dict) and s.get("active", True) is not False]

    # Group by (cleaned name, instructor, mode, is_lesson) so trial+regular
    # variants of the same lesson collapse into a single natural phrase.
    grouped: dict[tuple, list[dict]] = {}
    order: list[tuple] = []
    for svc in active:
        raw_name = _service_field(svc, "name", default="")
        if not raw_name:
            continue
        clean = _strip_trial(raw_name)
        instructor = _service_field(svc, "instructor")
        mode = _service_field(svc, "mode", default="both")
        is_lesson = _service_field(svc, "is_lesson")
        if is_lesson is None:
            is_lesson = "lesson" in clean.lower()
        key = (clean, instructor, mode, bool(is_lesson))
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append(svc)

    lessons: list[str] = []
    others: list[str] = []
    for key in order:
        clean_name, instructor, mode, is_lesson = key
        variants = grouped[key]
        durations = sorted({int(_service_field(v, "duration_minutes", "duration_min", default=0) or 0) for v in variants})
        prices = sorted({int(_service_field(v, "price", default=0) or 0) for v in variants if _service_field(v, "price", default=None) not in (None, 0)})

        line = clean_name
        if instructor:
            line += f" with {instructor}"

        if len(durations) == 1:
            line += f" — {durations[0]} minutes"
        elif len(durations) > 1:
            line += f" — {' or '.join(str(d) for d in durations)} minutes"

        if prices:
            if len(prices) == 1:
                line += f", ${prices[0]}"
            else:
                line += f" (${' or $'.join(str(p) for p in prices)})"

        if mode == "remote":
            line += " (remote only)"
        elif mode == "in_person" and is_lesson:
            line += " (in person)"

        if is_lesson:
            lessons.append(line)
        else:
            others.append(line)

    parts: list[str] = []
    if lessons:
        parts.append("Lessons: " + "; ".join(lessons) + ".")
    if others:
        parts.append("Other services: " + "; ".join(others) + ".")
    return " ".join(parts)


# ---------- rentals ----------

def render_rentals(rentals_json: Any) -> str:
    return _safe("render_rentals", lambda: _render_rentals_inner(rentals_json))


def _render_rentals_inner(rentals_json: Any) -> str:
    data = _coerce(rentals_json) or {}
    if not isinstance(data, dict):
        return ""

    sentences: list[str] = []
    short = data.get("short_term") or {}
    monthly = data.get("monthly_student") or {}

    if isinstance(short, dict) and short.get("enabled"):
        rate = short.get("day_rate", 0)
        deposit = short.get("deposit", 0)
        sentences.append(
            f"We offer short-term rentals at ${rate} per day with a ${deposit} deposit."
        )

    if isinstance(monthly, dict) and monthly.get("enabled"):
        rate = monthly.get("rate", 0)
        sentences.append(
            f"Monthly student rentals are available at ${rate} per month."
        )

    return " ".join(sentences)


# ---------- cancellation ----------

def render_cancellation_policy(policy_json: Any) -> str:
    return _safe("render_cancellation_policy", lambda: _render_cancellation_inner(policy_json))


def _render_cancellation_inner(policy_json: Any) -> str:
    data = _coerce(policy_json) or {}
    if not isinstance(data, dict) or not data.get("enabled"):
        return ""
    hours = data.get("hours_before", 48)
    percent = data.get("percent_charge", 50)
    return (
        f"We have a {hours}-hour cancellation policy. "
        f"If you cancel within {hours} hours, there is a {percent}% lesson charge "
        f"since the time is reserved for you."
    )


# ---------- payment portal ----------

def render_payment_portal(portal_json: Any) -> str:
    return _safe("render_payment_portal", lambda: _render_payment_inner(portal_json))


def _render_payment_inner(portal_json: Any) -> str:
    data = _coerce(portal_json) or {}
    if not isinstance(data, dict):
        return ""
    url = data.get("url")
    autopay = bool(data.get("mention_autopay"))
    if url:
        # Spoken layer says "on our website" — the literal URL belongs in SMS,
        # not in voice. Keeps the phone experience natural.
        if autopay:
            return "All payments are handled through our online portal on our website, and most families set up autopay for convenience."
        return "All payments are handled through our online portal on our website."
    if autopay:
        return "All payments are handled through our online portal, and most families set up autopay for convenience."
    return ""


# ---------- escalation ----------

def render_escalation(escalation_json: Any) -> str:
    return _safe("render_escalation", lambda: _render_escalation_inner(escalation_json))


def _render_escalation_inner(escalation_json: Any) -> str:
    data = _coerce(escalation_json) or {}
    if not isinstance(data, dict) or not data.get("live_person_callback"):
        return ""
    sla = data.get("callback_sla_text") or "shortly"
    return (
        f"I can help with most questions, but I can also have someone follow up with you {sla}. "
        f"Would you like me to arrange that?"
    )


# ---------- talent on tour ----------

def render_talent_on_tour(talent_json: Any) -> str:
    return _safe("render_talent_on_tour", lambda: _render_talent_inner(talent_json))


def _render_talent_inner(talent_json: Any) -> str:
    data = _coerce(talent_json) or {}
    if not isinstance(data, dict):
        return ""
    instructors = data.get("instructors") or []
    if not isinstance(instructors, list):
        return ""

    lines: list[str] = []
    for entry in instructors:
        if not isinstance(entry, dict):
            continue
        name = entry.get("instructor_name")
        desc = entry.get("description") or ""
        route = entry.get("route_to") or "callback_only"
        if not name:
            continue
        first_name = name.split()[0]

        if route == "start_with_other_instructor":
            lines.append(
                f"{name} is {desc}. We can absolutely get you started now with another "
                f"instructor so you're prepared when {first_name} is in session again."
            )
        elif route == "callback_only":
            lines.append(
                f"{name} is {desc}. I can take down your details and have someone follow up "
                f"about scheduling with {first_name}."
            )
        elif route == "remote_only":
            lines.append(
                f"{name} is {desc}. {first_name} teaches remotely; we can schedule a remote lesson."
            )
        else:
            lines.append(f"{name} is {desc}.")
    return "\n".join(lines)


# ---------- age policy ----------

def render_age_policy(age_json: Any) -> str:
    return _safe("render_age_policy", lambda: _render_age_inner(age_json))


def _render_age_inner(age_json: Any) -> str:
    data = _coerce(age_json) or {}
    if not isinstance(data, dict):
        return ""
    minimum = data.get("minimum_age")
    if minimum in (None, 0):
        return ""
    mode = data.get("mode") or "soft"
    if mode == "hard":
        return f"We start students at age {minimum} and up."
    return (
        f"We typically start students around age {minimum} and up. "
        f"Some younger students can begin if they're able to focus."
    )


# ---------- languages ----------

def render_languages(languages_json: Any) -> str:
    return _safe("render_languages", lambda: _render_languages_inner(languages_json))


def _render_languages_inner(languages_json: Any) -> str:
    data = _coerce(languages_json) or {}
    if not isinstance(data, dict):
        return ""
    mirrors = data.get("mirrors") or []
    if not isinstance(mirrors, list):
        return ""
    lines: list[str] = []
    for m in mirrors:
        if not isinstance(m, dict):
            continue
        trigger = m.get("trigger")
        response = m.get("response")
        if trigger and response:
            lines.append(
                f'If a caller greets you with "{trigger}", respond with "{response}" '
                f"and continue in English."
            )
    return "\n".join(lines)
