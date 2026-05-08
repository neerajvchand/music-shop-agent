from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Twilio
    twilio_account_sid: str
    twilio_auth_token: str
    twilio_sms_number: str = ""  # Sender number for SMS

    # Deepgram
    deepgram_api_key: str

    # Google (Calendar OAuth + Judge/Synthesis)
    google_client_id: str = ""
    google_client_secret: str = ""
    google_api_key: str = ""  # For Gemini judge/synthesis

    # Supabase
    supabase_url: str
    supabase_service_role_key: str

    # App
    app_base_url: str
    log_level: str = "INFO"

    # URL of the Vercel dashboard service that hosts the HMAC-authenticated
    # /api/agent/* endpoints. Required as of Phase 2 — Railway calls Vercel
    # for all calendar operations. Production: https://music-shop-agent.vercel.app
    dashboard_base_url: str = ""

    # Shared secret for the HMAC handshake between Railway agent and Vercel
    # /api/agent/* routes. Must match the AGENT_API_SECRET env var set on
    # Vercel. Both sides sign `f"{shop_id}:{timestamp_ms}"` with SHA256 hex.
    agent_api_secret: str = ""

    # Multiplier for Deepgram TTS speech rate. 1.0 = default, 1.10 = 10% faster.
    # Tunable per deploy via the TTS_SPEECH_RATE env var (uppercase env →
    # lowercase Settings field). Tweak to dial in natural pacing without code
    # changes. Deepgram silently ignores out-of-range values.
    tts_speech_rate: float = 1.10

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


# Fail fast at import time if required vars are missing
settings = Settings()  # type: ignore[call-arg]
