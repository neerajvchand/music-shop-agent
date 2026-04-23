"""Deepgram Voice Agent API WebSocket client."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncGenerator

import websockets
from websockets.asyncio.client import ClientConnection

from app.shops import Shop

logger = logging.getLogger(__name__)

DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse"
KEEPALIVE_INTERVAL = 5  # seconds


class DeepgramAgentClient:
    def __init__(self, api_key: str, shop: Shop):
        self._api_key = api_key
        self._shop = shop
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
        }
        if self._shop.keyterms:
            listen_provider["keyterms"] = self._shop.keyterms

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
                    "prompt": self._shop.system_prompt,
                    "functions": [
                        {
                            "name": "end_call",
                            "description": "End the phone call after the caller says goodbye or the conversation is complete.",
                            "parameters": {"type": "object", "properties": {}},
                        },
                    ],
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

    async def inject_goodbye(self) -> None:
        """Inject a goodbye message for the agent to speak."""
        if self._ws:
            msg = {
                "type": "InjectAgentMessage",
                "content": "I'm sorry, but we've reached the maximum call duration. Thank you for calling, goodbye!",
            }
            await self._ws.send(json.dumps(msg))

    async def send_function_call_response(
        self, function_id: str, name: str, result: str
    ) -> None:
        """Send a FunctionCallResponse back to Deepgram."""
        if self._ws:
            msg = {
                "type": "FunctionCallResponse",
                "function_call_id": function_id,
                "name": name,
                "output": result,
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
