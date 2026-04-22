from app.shops import Shop


SAMPLE_ROW = {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "slug": "test-shop",
    "name": "Test Music Shop",
    "status": "active",
    "twilio_number": "+15551234567",
    "owner_name": "Test Owner",
    "owner_phone": "+15559876543",
    "owner_email": "test@example.com",
    "timezone": "America/Los_Angeles",
    "locale": "en-US",
    "greeting": "Hello, welcome to Test Music Shop!",
    "system_prompt": "You are a helpful assistant.",
    "voice_id": "aura-2-minerva-en",
    "llm_provider": "google",
    "llm_model": "gemini-2.5-flash",
    "business_hours_json": {"monday": {"open": "10:00", "close": "17:00"}},
    "services_json": [{"slug": "lesson", "name": "Lesson", "duration_min": 30}],
    "tool_definitions_json": [],
    "gcal_calendar_id": None,
    "gcal_service_account_email": None,
    "approval_mode": "propose_only",
    "created_at": "2025-01-01T00:00:00+00:00",
    "updated_at": "2025-01-01T00:00:00+00:00",
}


def test_shop_model_parses_full_row():
    """Shop model parses a complete Supabase row."""
    shop = Shop(**SAMPLE_ROW)
    assert shop.slug == "test-shop"
    assert shop.name == "Test Music Shop"
    assert shop.voice_id == "aura-2-minerva-en"
    assert shop.llm_provider == "google"
    assert shop.business_hours_json["monday"]["open"] == "10:00"


def test_shop_model_handles_nullable_fields():
    """Shop model handles null optional fields."""
    row = {**SAMPLE_ROW, "owner_email": None, "gcal_calendar_id": None}
    shop = Shop(**row)
    assert shop.owner_email is None
    assert shop.gcal_calendar_id is None


def test_shop_model_minimal_row():
    """Shop model works with only required fields."""
    minimal = {k: v for k, v in SAMPLE_ROW.items() if k not in ("created_at", "updated_at", "owner_email")}
    shop = Shop(**minimal)
    assert shop.slug == "test-shop"
    assert shop.created_at is None
