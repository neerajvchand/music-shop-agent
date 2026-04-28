-- Shop integrations (Google Calendar OAuth, etc.)
CREATE TABLE IF NOT EXISTS public.shop_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google_calendar')),
    provider_account_email TEXT,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'expired', 'disconnected', 'error')),
    last_error TEXT,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(shop_id, provider)
);

-- Structured call event log (state transitions, tool calls, slot fills)
CREATE TABLE IF NOT EXISTS public.call_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
    call_sid TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'state_transition', 'tool_call', 'tool_result', 'slot_extracted',
        'slot_confirmed', 'slot_rejected', 'booking_created', 'booking_cancelled',
        'caller_disconnected', 'silence_timeout', 'max_duration_reached',
        'recovery_triggered', 'injected_message'
    )),
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_events_call_sid ON public.call_events(call_sid);
CREATE INDEX IF NOT EXISTS idx_call_events_shop_created ON public.call_events(shop_id, created_at);

-- Owner decisions inbox
CREATE TABLE IF NOT EXISTS public.owner_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
    decision_type TEXT NOT NULL CHECK (decision_type IN (
        'add_service', 'add_keyterm', 'update_hours', 'approve_refund',
        'handle_complaint', 'connect_calendar', 'review_prompt_patch'
    )),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed', 'auto_resolved')),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_decisions_shop_status ON public.owner_decisions(shop_id, status);

-- Daily summaries
CREATE TABLE IF NOT EXISTS public.daily_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
    summary_date DATE NOT NULL,
    calls_count INTEGER NOT NULL DEFAULT 0,
    bookings_count INTEGER NOT NULL DEFAULT 0,
    missed_calls_count INTEGER NOT NULL DEFAULT 0,
    top_intents_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    decisions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    digest_text TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(shop_id, summary_date)
);
