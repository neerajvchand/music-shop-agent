from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Twilio
    twilio_account_sid: str
    twilio_auth_token: str

    # Deepgram
    deepgram_api_key: str

    # Supabase
    supabase_url: str
    supabase_service_role_key: str

    # App
    app_base_url: str
    log_level: str = "INFO"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


# Fail fast at import time if required vars are missing
settings = Settings()  # type: ignore[call-arg]
