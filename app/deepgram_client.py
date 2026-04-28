"""Deepgram Voice Agent API WebSocket client."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncGenerator

import websockets
from websockets.asyncio.client import ClientConnection

from app.prompts.composer import CallContext, compose
from app.shops import Shop

logger = logging.getLogger(__name__)

DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse"
KEEPALIVE_INTERVAL = 5  # seconds


class DeepgramAgentClient:
    def __init__(self, api_key: str, shop: Shop, call_context: CallContext | None = None):
        self._api_key = api_key
        self._shop = shop
        self._call_context = call_context
        self._ws: ClientConnection | None = None
        self._keepalive_task: asyncio.Task | None = None

    async def connect(self) -> None:
        """Open WebSocket to Deepgram and send initial Settings message."""
        headers = {"Authorization": f"Token {self._api_key}"}
        self._ws = await websockets.connect(DEEPGRAM_AGENT_URL, additional_headers=headers)

        settings_msg = self._build_settings()
        await self._ws.send(json.dumps(settings_msg))
        logger.info("Deepgram agent connected, settings sent for shop=%s", self._shop.slug)

        self._keepalive_task = asyncio.create_task(self._keepalive_loop())

    def _build_settings(self) -> dict:
        listen_provider: dict = {
            "type": "deepgram",
            "model": "nova-3",
            "endpointing": 300,  # 300ms for lower latency
        }
        if self._shop.keyterms:
            listen_provider["keyterms"] = self._shop.keyterms

        # Use compositional prompt if available, else fall back to monolithic prompt
        system_prompt = self._shop.system_prompt
        functions = self._default_functions()

        if self._call_context:
            try:
                composed_prompt, composed_tools = compose(self._call_context)
                if composed_prompt:
                    system_prompt = composed_prompt
                if composed_tools:
                    functions = composed_tools
            except Exception as e:
                logger.warning("Prompt composition failed, using fallback: %s", e)

        return {
            "type": "Settings",
            "audio": {
                "input": {
                    "encoding": "mulaw",
                    "sample_rate": 8000,
                },
                "output": {
                    "encoding": "mulaw",
                    "sample_rate": 8000,
                    "container": "none",
                },
            },
            "agent": {
                "listen": {
                    "provider": listen_provider,
                },
                "think": {
                    "provider": {
                        "type": self._shop.llm_provider,
                        "model": self._shop.llm_model,
                    },
                    "prompt": system_prompt,
                    "functions": functions,
                },
                "speak": {
                    "provider": {
                        "type": "deepgram",
                        "model": self._shop.voice_id,
                    },
                },
                "greeting": self._shop.greeting,
            },
        }

    def _default_functions(self) -> list[dict]:
        return [
            {
                "name": "end_call",
                "description": "End the phone call after the caller says goodbye or the conversation is complete.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "caller_confirmed_done": {
                            "type": "boolean",
                            "description": "Set to true ONLY if the caller has explicitly confirmed they have no further questions.",
                        },
                        "reason": {
                            "type": "string",
                            "description": "Brief reason (e.g., 'caller confirmed done', 'escalation to owner')",
                        },
                    },
                    "required": ["caller_confirmed_done", "reason"],
                },
            },
            {
                "name": "check_availability",
                "description": "Check if a proposed appointment time is available. Call this BEFORE offering a specific slot to the caller. Do NOT call this if the caller hasn't given you a service and preferred day yet.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "service": {"type": "string"},
                        "date": {"type": "string", "description": "ISO date, e.g. 2026-04-28"},
                        "time": {"type": "string", "description": "24-hour time, e.g. 15:00"},
                    },
                    "required": ["service", "date", "time"],
                },
            },
            {
                "name": "book_appointment",
                "description": "Book a confirmed appointment. Only call this after the caller has verbally confirmed ALL details including their name, phone, service, date, and time. This writes to the calendar.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "service": {"type": "string"},
                        "date": {"type": "string"},
                        "time": {"type": "string"},
                        "customer_name": {"type": "string"},
                        "customer_phone": {"type": "string"},
                        "notes": {"type": "string"},
                    },
                    "required": ["service", "date", "time", "customer_name", "customer_phone"],
                },
            },
            {
                "name": "collect_slot",
                "description": "Report that a slot value has been extracted from the conversation. Use this to record the caller's answer to a specific question.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "slot_name": {"type": "string", "description": "e.g. service, preferred_day, student_name, student_phone"},
                        "value": {"type": "string"},
                    },
                    "required": ["slot_name", "value"],
                },
            },
            {
                "name": "confirm_slot",
                "description": "Report that the caller has confirmed a slot value (e.g., repeated phone number back correctly).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "slot_name": {"type": "string"},
                    },
                    "required": ["slot_name"],
                },
            },
            {
                "name": "reject_slot",
                "description": "Report that the caller rejected or corrected a slot value. The agent should re-collect it.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "slot_name": {"type": "string"},
                    },
                    "required": ["slot_name"],
                },
            },
        ]

    async def send_audio(self, chunk: bytes) -> None:
        """Send raw audio bytes to Deepgram."""
        if self._ws:
            await self._ws.send(chunk)

    async def receive_events(self) -> AsyncGenerator[dict, None]:
        """Yield parsed events from Deepgram. Yields bytes for audio."""
        if not self._ws:
            return

        try:
            async for message in self._ws:
                if isinstance(message, bytes):
                    yield {"type": "Audio", "data": message}
                else:
                    try:
                        event = json.loads(message)
                        yield event
                    except json.JSONDecodeError:
                        logger.warning("Non-JSON text from Deepgram: %s", message[:100])
        except websockets.exceptions.ConnectionClosed as e:
            logger.info("Deepgram WebSocket closed: %s", e)

        logger.info("Deepgram WebSocket receive loop exiting")

    async def inject_goodbye(self, message: str | None = None) -> None:
        """Inject a goodbye message for the agent to speak."""
        if self._ws:
            msg = {
                "type": "InjectAgentMessage",
                "content": message or "I'm sorry, but we've reached the maximum call duration. Thank you for calling, goodbye!",
            }
            await self._ws.send(json.dumps(msg))

    async def send_function_call_response(
        self, function_id: str, name: str, result: str
    ) -> None:
        """Send a FunctionCallResponse back to Deepgram."""
        if self._ws:
            msg = {
                "type": "FunctionCallResponse",
                "id": function_id,
                "name": name,
                "content": result,
            }
            await self._ws.send(json.dumps(msg))

    async def close(self) -> None:
        """Clean up WebSocket and keepalive task."""
        if self._keepalive_task:
            self._keepalive_task.cancel()
            try:
                await self._keepalive_task
            except asyncio.CancelledError:
                pass
            self._keepalive_task = None

        if self._ws:
            await self._ws.close()
            self._ws = None

    async def _keepalive_loop(self) -> None:
        """Send periodic pings to keep the WebSocket alive."""
        try:
            while True:
                await asyncio.sleep(KEEPALIVE_INTERVAL)
                if self._ws:
                    await self._ws.send(json.dumps({"type": "KeepAlive"}))
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning("Keepalive loop error: %s", e)
