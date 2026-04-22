"""Audio utilities for Twilio Media Stream <-> Deepgram bridge.

Deepgram Voice Agent API supports mulaw at 8000Hz directly, so no format
conversion is needed. We only handle the base64 encoding/decoding that
Twilio's Media Stream protocol requires.
"""

import base64
import json


def decode_twilio_media(payload: dict) -> bytes:
    """Extract raw audio bytes from a Twilio media message."""
    return base64.b64decode(payload["media"]["payload"])


def encode_for_twilio(chunk: bytes, stream_sid: str) -> str:
    """Wrap raw audio bytes into a Twilio media message (JSON string)."""
    return json.dumps(
        {
            "event": "media",
            "streamSid": stream_sid,
            "media": {"payload": base64.b64encode(chunk).decode("ascii")},
        }
    )


def build_clear_message(stream_sid: str) -> str:
    """Build a Twilio clear message to interrupt playback (barge-in)."""
    return json.dumps({"event": "clear", "streamSid": stream_sid})
