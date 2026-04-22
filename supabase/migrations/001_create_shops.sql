CREATE TABLE shops (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            text UNIQUE NOT NULL,
    name            text NOT NULL,
    status          text NOT NULL DEFAULT 'active',
    twilio_number   text UNIQUE NOT NULL,
    owner_name      text NOT NULL,
    owner_phone     text NOT NULL,
    owner_email     text,
    timezone        text NOT NULL DEFAULT 'America/Los_Angeles',
    locale          text NOT NULL DEFAULT 'en-US',
    greeting        text NOT NULL,
    system_prompt   text NOT NULL,
    voice_id        text NOT NULL DEFAULT 'aura-2-minerva-en',
    llm_provider    text NOT NULL DEFAULT 'google',
    llm_model       text NOT NULL DEFAULT 'gemini-2.5-flash',
    business_hours_json     jsonb NOT NULL,
    services_json           jsonb NOT NULL,
    tool_definitions_json   jsonb NOT NULL DEFAULT '[]'::jsonb,
    gcal_calendar_id            text,
    gcal_service_account_email  text,
    approval_mode   text NOT NULL DEFAULT 'propose_only',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_shops_twilio_number ON shops (twilio_number);
CREATE INDEX idx_shops_status ON shops (status);
