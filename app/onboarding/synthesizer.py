"""Synthesize a business_module prompt from an onboarding interview transcript."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

SYNTHESIS_PROMPT = """You are a prompt engineering assistant.

Given an onboarding interview transcript, produce a structured business configuration.

Output valid JSON with these keys:
- business_name: string
- services: array of {name, duration_min, price_hint, description}
- business_hours: object with days as keys and {open, close} values
- staff: array of strings (names)
- common_phrases: array of strings (things callers typically say)
- special_instructions: string (parking, cancellations, etc.)
- vertical: one of [music_lessons, salon, notary, auto_repair, generic]
- system_prompt_facts: string (2-3 sentences the agent should know about this business)

Be concise. Do not invent prices unless mentioned.
"""


async def synthesize_business_module(transcript: str) -> dict[str, Any]:
    """Convert an onboarding transcript into a structured business module."""
    if not settings.google_api_key:
        logger.warning("No Google API key for synthesis; returning empty config")
        return _empty_config()

    try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-04-17:generateContent?key={settings.google_api_key}"
        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": SYNTHESIS_PROMPT},
                        {"text": f"Transcript:\n{transcript}"},
                    ],
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
            },
        }
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            config = json.loads(text)
            logger.info("Synthesized business config with vertical=%s", config.get("vertical"))
            return config
    except Exception as e:
        logger.error("Synthesis failed: %s", e)
        return _empty_config()


def _empty_config() -> dict[str, Any]:
    return {
        "business_name": "",
        "services": [],
        "business_hours": {},
        "staff": [],
        "common_phrases": [],
        "special_instructions": "",
        "vertical": "generic",
        "system_prompt_facts": "",
    }
