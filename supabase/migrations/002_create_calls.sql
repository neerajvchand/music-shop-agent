CREATE TABLE calls (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id             uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    started_at          timestamptz NOT NULL DEFAULT now(),
    ended_at            timestamptz,
    duration_s          integer,
    caller_phone        text,
    twilio_call_sid     text UNIQUE,
    transcript          text,
    summary             text,
    intents             text[] NOT NULL DEFAULT '{}',
    outcome             text,
    confidence          numeric(3,2),
    voice_cost_cents    integer,
    llm_tokens_in       integer,
    llm_tokens_out      integer,
    twilio_cost_cents   integer,
    error               text,
    raw_events_json     jsonb
);

CREATE INDEX idx_calls_shop_started ON calls (shop_id, started_at DESC);
