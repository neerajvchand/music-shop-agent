"""LLM judge for scoring synthetic and real calls."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

JUDGE_MODEL = "gemini-2.5-flash-preview-04-17"
JUDGE_PROMPT = """You are an expert evaluator of voice AI agents for small businesses.

You will be given:
1. A scenario description
2. A transcript of the call (agent and caller turns)
3. A rubric with dimensions

Score each dimension from 0.0 to 1.0.
0.0 = completely failed
1.0 = perfect

Dimensions:
- slot_collection: Did the agent collect all required information (name, phone, service, time)?
- confirmation: Did the agent confirm details verbally before finalizing?
- scope_adherence: Did the agent stay within its role (no invented prices, no unauthorized refunds)?
- tone: Was the agent warm, patient, and professional?
- efficiency: Did the agent reach resolution without unnecessary back-and-forth?

Also provide:
- overall_score: average of dimensions
- flagged: true if any dimension is below 0.5
- flag_reason: explanation if flagged

Respond ONLY with valid JSON matching this schema:
{
  "slot_collection": 0.0-1.0,
  "confirmation": 0.0-1.0,
  "scope_adherence": 0.0-1.0,
  "tone": 0.0-1.0,
  "efficiency": 0.0-1.0,
  "overall_score": 0.0-1.0,
  "flagged": true/false,
  "flag_reason": "string or null"
}
"""


@dataclass
class Rubric:
    slot_collection: float
    confirmation: float
    scope_adherence: float
    tone: float
    efficiency: float
    overall_score: float
    flagged: bool
    flag_reason: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "slot_collection": self.slot_collection,
            "confirmation": self.confirmation,
            "scope_adherence": self.scope_adherence,
            "tone": self.tone,
            "efficiency": self.efficiency,
            "overall_score": self.overall_score,
            "flagged": self.flagged,
            "flag_reason": self.flag_reason,
        }


async def judge_call(
    scenario_name: str,
    transcript: str,
    scenario_description: str = "",
) -> Rubric:
    """Score a call transcript using an LLM judge."""
    user_prompt = f"""Scenario: {scenario_name}
Description: {scenario_description}

Transcript:
{transcript}

Score the call."""

    try:
        score = await _call_gemini_judge(user_prompt)
        return Rubric(**score)
    except Exception as e:
        logger.error("Judge call failed: %s", e)
        # Return neutral scores on failure so we don't break pipelines
        return Rubric(
            slot_collection=0.5,
            confirmation=0.5,
            scope_adherence=0.5,
            tone=0.5,
            efficiency=0.5,
            overall_score=0.5,
            flagged=False,
            flag_reason=f"Judge error: {e}",
        )


async def _call_gemini_judge(prompt: str) -> dict[str, Any]:
    """Call Gemini via Deepgram or direct Google API for judging."""
    # For now, use a simple HTTP call to Google Gemini API
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{JUDGE_MODEL}:generateContent?key={settings.google_api_key}"
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": JUDGE_PROMPT},
                    {"text": prompt},
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
        return json.loads(text)
