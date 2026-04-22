import os
import pytest


def test_config_loads_with_valid_env(monkeypatch):
    """Config loads correctly when all required env vars are set."""
    env_vars = {
        "TWILIO_ACCOUNT_SID": "ACtest123",
        "TWILIO_AUTH_TOKEN": "test_token",
        "DEEPGRAM_API_KEY": "dg_test_key",
        "SUPABASE_URL": "https://test.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "test_service_key",
        "APP_BASE_URL": "https://test.railway.app",
    }
    for k, v in env_vars.items():
        monkeypatch.setenv(k, v)

    # Import fresh to trigger validation
    from pydantic_settings import BaseSettings

    class TestSettings(BaseSettings):
        twilio_account_sid: str
        twilio_auth_token: str
        deepgram_api_key: str
        supabase_url: str
        supabase_service_role_key: str
        app_base_url: str
        log_level: str = "INFO"

    s = TestSettings()  # type: ignore[call-arg]
    assert s.twilio_account_sid == "ACtest123"
    assert s.log_level == "INFO"


def test_config_raises_on_missing_vars(monkeypatch):
    """Config raises ValidationError when required vars are missing."""
    # Clear all relevant env vars
    for key in [
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "DEEPGRAM_API_KEY",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "APP_BASE_URL",
    ]:
        monkeypatch.delenv(key, raising=False)

    from pydantic_settings import BaseSettings
    from pydantic import ValidationError

    class TestSettings(BaseSettings):
        twilio_account_sid: str
        twilio_auth_token: str
        deepgram_api_key: str
        supabase_url: str
        supabase_service_role_key: str
        app_base_url: str

        model_config = {"env_file": None}

    with pytest.raises(ValidationError):
        TestSettings()  # type: ignore[call-arg]
