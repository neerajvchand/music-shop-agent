"""Onboarding agent — interviews a shop owner over the phone to extract config."""

from __future__ import annotations

import json
import logging
from typing import Any

from app.deepgram_client import DeepgramAgentClient
from app.shops import Shop

logger = logging.getLogger(__name__)

ONBOARDING_PROMPT = """You are a friendly onboarding assistant for a voice AI phone agent service.

Your goal is to interview a small business owner and collect the following information:
1. Business name
2. Services offered (list them clearly)
3. Business hours (days and times open)
4. Staff members (names, if customers ask for specific people)
5. Common reasons people call
6. Any special instructions (parking, cancellations, deposits)

Ask one question at a time. Be warm and conversational. After each answer, briefly acknowledge and move to the next question.

When you have all the information, say: "Thank you! I've got everything I need. Your agent will be ready shortly."

Do NOT make up information. If the owner is unsure, note it and move on.
"""

ONBOARDING_TOOLS = [
    {
        "name": "submit_onboarding",
        "description": "Call this when the interview is complete and all information has been collected.",
        "parameters": {
            "type": "object",
            "properties": {
                "business_name": {"type": "string"},
                "services": {"type": "string", "description": "Comma-separated list of services"},
                "business_hours": {"type": "string", "description": "e.g., Mon-Fri 9am-6pm, Sat 10am-4pm"},
                "staff": {"type": "string", "description": "Comma-separated staff names or 'just me'"},
                "common_calls": {"type": "string"},
                "special_instructions": {"type": "string"},
            },
            "required": ["business_name", "services", "business_hours"],
        },
    }
]


class OnboardingAgent:
    """Wraps Deepgram agent configured for onboarding interviews."""

    def __init__(self, api_key: str):
        self._api_key = api_key

    def build_shop_for_onboarding(self, slug: str, twilio_number: str) -> Shop:
        """Create a temporary shop config for the onboarding call."""
        return Shop(
            id="onboarding",
            slug=slug,
            name="Onboarding",
            status="onboarding",
            twilio_number=twilio_number,
            owner_name="",
            owner_phone="",
            timezone="America/Los_Angeles",
            locale="en-US",
            greeting="Hi there! I'm here to help set up your AI phone agent. Let's start with your business name.",
            farewell="Thanks so much! We'll have your agent ready soon.",
            system_prompt=ONBOARDING_PROMPT,
            voice_id="aura-2",
            llm_provider="google",
            llm_model="gemini-2.5-flash-preview-04-17",
            business_hours_json={},
            services_json=[],
            tool_definitions_json=ONBOARDING_TOOLS,
            keyterms=[],
            approval_mode="auto",
        )

    async def process_onboarding_result(self, result: dict[str, Any]) -> dict[str, Any]:
        """Process the structured output from an onboarding call."""
        logger.info("Onboarding result: %s", result)
        return result
