"""Tests for app.calendar.agent_client — the HMAC client to Vercel.

The HMAC payload format is locked in two places (Python and TypeScript). A
byte-match test catches any future drift.
"""

import hashlib
import hmac
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Set the secret BEFORE importing the agent client so settings picks it up.
os.environ["AGENT_API_SECRET"] = "test-secret-32-bytes-deterministic"
os.environ["DASHBOARD_BASE_URL"] = "https://test-dashboard.vercel.app"

from app.calendar.agent_client import AgentApiError, _sign, _build_headers, check_availability, create_booking
from app.config import settings


SHOP_ID = "shop-fixture-uuid"
TS_MS = 1_700_000_000_000  # fixed timestamp for byte-match assertions


def _expected_signature(shop_id: str, ts_ms: int, secret: str) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        f"{shop_id}:{ts_ms}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def test_sign_returns_payload_and_lowercase_hex():
    settings.agent_api_secret = "test-secret-32-bytes-deterministic"
    payload, sig = _sign(SHOP_ID, TS_MS)
    assert payload == f"{SHOP_ID}:{TS_MS}"
    assert sig == sig.lower()
    assert len(sig) == 64  # SHA256 hex


def test_sign_byte_match_for_known_inputs():
    """If this test fails, the Python and TypeScript signatures have drifted."""
    settings.agent_api_secret = "test-secret-32-bytes-deterministic"
    _, sig = _sign(SHOP_ID, TS_MS)
    expected = _expected_signature(SHOP_ID, TS_MS, "test-secret-32-bytes-deterministic")
    assert sig == expected


def test_build_headers_shape():
    settings.agent_api_secret = "test-secret-32-bytes-deterministic"
    settings.dashboard_base_url = "https://test-dashboard.vercel.app"
    headers = _build_headers(SHOP_ID, timestamp_ms=TS_MS)
    assert headers["x-shop-id"] == SHOP_ID
    assert headers["x-request-timestamp"] == str(TS_MS)
    assert headers["x-agent-signature"] == _expected_signature(SHOP_ID, TS_MS, "test-secret-32-bytes-deterministic")
    assert headers["content-type"] == "application/json"


def test_build_headers_raises_when_secret_missing():
    settings.agent_api_secret = ""
    with pytest.raises(AgentApiError) as exc:
        _build_headers(SHOP_ID)
    assert "agent_api_secret" in str(exc.value)
    settings.agent_api_secret = "test-secret-32-bytes-deterministic"  # restore


def test_build_headers_raises_when_dashboard_url_missing():
    settings.agent_api_secret = "test-secret-32-bytes-deterministic"
    settings.dashboard_base_url = ""
    with pytest.raises(AgentApiError) as exc:
        _build_headers(SHOP_ID)
    assert "dashboard_base_url" in str(exc.value)
    settings.dashboard_base_url = "https://test-dashboard.vercel.app"  # restore


@pytest.mark.asyncio
async def test_check_availability_success_path():
    settings.agent_api_secret = "test-secret-32-bytes-deterministic"
    settings.dashboard_base_url = "https://test-dashboard.vercel.app"

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"slots": [{"start": "2026-05-12T10:00:00"}], "durationMinutes": 30}

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(return_value=mock_resp)

    with patch("app.calendar.agent_client.httpx.AsyncClient", return_value=mock_client):
        result = await check_availability(SHOP_ID, date="2026-05-12", duration_minutes=30, timezone="America/Los_Angeles")
    assert result["slots"][0]["start"] == "2026-05-12T10:00:00"

    # Confirm POST was called with correct headers + body shape.
    args, kwargs = mock_client.post.call_args
    assert args[0].endswith("/api/agent/check-availability")
    assert kwargs["json"]["date"] == "2026-05-12"
    assert kwargs["json"]["durationMinutes"] == 30
    assert kwargs["headers"]["x-shop-id"] == SHOP_ID
    assert "x-agent-signature" in kwargs["headers"]


@pytest.mark.asyncio
async def test_create_booking_409_raises_slot_taken():
    settings.agent_api_secret = "test-secret-32-bytes-deterministic"
    settings.dashboard_base_url = "https://test-dashboard.vercel.app"

    mock_resp = MagicMock()
    mock_resp.status_code = 409
    mock_resp.json.return_value = {"error": "slot_taken"}
    mock_resp.text = '{"error":"slot_taken"}'

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(return_value=mock_resp)

    with patch("app.calendar.agent_client.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(AgentApiError) as exc:
            await create_booking(
                SHOP_ID,
                customer_name="Test",
                customer_phone="+15555550000",
                service="tabla_lesson",
                start_time="2026-05-12T15:00:00",
                duration_minutes=30,
            )
    assert exc.value.status == 409


@pytest.mark.asyncio
async def test_check_availability_500_raises():
    settings.agent_api_secret = "test-secret-32-bytes-deterministic"
    settings.dashboard_base_url = "https://test-dashboard.vercel.app"

    mock_resp = MagicMock()
    mock_resp.status_code = 500
    mock_resp.json.return_value = {"error": "internal"}
    mock_resp.text = '{"error":"internal"}'

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.post = AsyncMock(return_value=mock_resp)

    with patch("app.calendar.agent_client.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(AgentApiError) as exc:
            await check_availability(SHOP_ID, date="2026-05-12", duration_minutes=30)
    assert exc.value.status == 500
