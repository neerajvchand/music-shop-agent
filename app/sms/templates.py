"""SMS message templates. Pure functions — no side effects."""

from __future__ import annotations

from typing import Any

from app.shops import Shop


def render_confirmation(
    shop: Shop,
    service: str,
    scheduled_at: str,
    reschedule_link: str = "",
) -> str:
    lines = [
        f"You're booked for {service} at {shop.name} on {scheduled_at}.",
    ]
    if reschedule_link:
        lines.append(f"Need to reschedule? {reschedule_link}")
    lines.append(f"Reply STOP to opt out.")
    return " ".join(lines)


def render_reminder(
    shop: Shop,
    service: str,
    scheduled_at: str,
    reschedule_link: str = "",
) -> str:
    lines = [
        f"Reminder: Your {service} at {shop.name} is tomorrow at {scheduled_at}.",
    ]
    if reschedule_link:
        lines.append(f"Reschedule: {reschedule_link}")
    return " ".join(lines)


def render_owner_alert(shop: Shop, decision_type: str, context: dict[str, Any]) -> str:
    if decision_type == "first_time_customer":
        name = context.get("customer_name", "A new caller")
        return f"{shop.name}: {name} just booked for the first time. {context.get('service', '')} on {context.get('scheduled_at', '')}."
    if decision_type == "high_value_service":
        return f"{shop.name}: High-value booking — {context.get('service', '')} for {context.get('customer_name', '')} on {context.get('scheduled_at', '')}."
    if decision_type == "after_hours":
        return f"{shop.name}: After-hours booking from {context.get('customer_name', '')} for {context.get('service', '')} on {context.get('scheduled_at', '')}."
    return f"{shop.name}: New booking — {context.get('service', '')} for {context.get('customer_name', '')} on {context.get('scheduled_at', '')}."


def render_digest(shop: Shop, summary: dict[str, Any]) -> str:
    calls = summary.get("calls_count", 0)
    bookings = summary.get("bookings_count", 0)
    missed = summary.get("missed_calls_count", 0)
    decisions = summary.get("decisions_json", [])

    lines = [
        f"{shop.name} yesterday: {calls} calls, {bookings} booked, {missed} missed.",
    ]

    if bookings > 0:
        top = summary.get("top_intents_json", [])
        if top:
            lines.append(f"Top asks: {', '.join(str(t) for t in top[:3])}.")

    if decisions:
        lines.append(f"Decisions needed: {len(decisions)}. Reply VIEW for details.")

    return " ".join(lines)
