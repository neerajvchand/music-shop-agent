"""Pytest fixtures and shared environment setup.

Sets dummy values for the env vars that `app.config.Settings` requires at
import time so unit tests for pure modules (renderers, composers, models)
don't need real credentials.
"""

import os

_DEFAULT_ENV = {
    "TWILIO_ACCOUNT_SID": "ACtest",
    "TWILIO_AUTH_TOKEN": "test_token",
    "DEEPGRAM_API_KEY": "dg_test",
    "SUPABASE_URL": "https://test.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "test_key",
    "APP_BASE_URL": "https://test.local",
}

for k, v in _DEFAULT_ENV.items():
    os.environ.setdefault(k, v)
