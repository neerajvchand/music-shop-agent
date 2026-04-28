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

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


# Fail fast at import time if required vars are missing
settings = Settings()  # type: ignore[call-arg]
