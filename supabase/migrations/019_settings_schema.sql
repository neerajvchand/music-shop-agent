-- Migration A: Settings as source of truth — schema additions
--
-- Adds the JSON columns and flat columns required to drive the agent prompt
-- entirely from owner-editable dashboard settings. Backfills two columns
-- (booking_buffer_minutes, off_hours_behavior) that the dashboard already
-- selects but were never committed as a migration in this repo.
--
-- All defaults are chosen so existing rows keep their current behavior.
-- New shops onboard by inserting a row + filling the dashboard form.

-- Flat columns the prompt templates need by reference
ALTER TABLE public.shops
    ADD COLUMN IF NOT EXISTS public_phone text,
    ADD COLUMN IF NOT EXISTS address text;

-- Settings already used by the dashboard but not previously committed
ALTER TABLE public.shops
    ADD COLUMN IF NOT EXISTS booking_buffer_minutes integer NOT NULL DEFAULT 15,
    ADD COLUMN IF NOT EXISTS off_hours_behavior text NOT NULL DEFAULT 'offer_callback';

-- New JSON columns. Defaults are deliberately disabled / empty so that for
-- any existing shop the rendered text comes back as "" — the prompt simply
-- omits the section. Owners opt in by toggling fields in the dashboard.

ALTER TABLE public.shops
    ADD COLUMN IF NOT EXISTS languages_json jsonb NOT NULL DEFAULT
        '{"mirrors": []}'::jsonb;

ALTER TABLE public.shops
    ADD COLUMN IF NOT EXISTS rentals_json jsonb NOT NULL DEFAULT
        '{"short_term": {"enabled": false, "day_rate": 0, "deposit": 0},
          "monthly_student": {"enabled": false, "rate": 0}}'::jsonb;

ALTER TABLE public.shops
    ADD COLUMN IF NOT EXISTS cancellation_policy_json jsonb NOT NULL DEFAULT
        '{"enabled": false, "hours_before": 48, "percent_charge": 50,
          "mention_when": "asked_only"}'::jsonb;

ALTER TABLE public.shops
    ADD COLUMN IF NOT EXISTS payment_portal_json jsonb NOT NULL DEFAULT
        '{"url": null, "mention_autopay": false}'::jsonb;

ALTER TABLE public.shops
    ADD COLUMN IF NOT EXISTS escalation_json jsonb NOT NULL DEFAULT
        '{"live_person_callback": false, "callback_sla_text": "shortly"}'::jsonb;

ALTER TABLE public.shops
    ADD COLUMN IF NOT EXISTS talent_on_tour_json jsonb NOT NULL DEFAULT
        '{"instructors": []}'::jsonb;

ALTER TABLE public.shops
    ADD COLUMN IF NOT EXISTS age_policy_json jsonb NOT NULL DEFAULT
        '{"minimum_age": 0, "mode": "soft"}'::jsonb;

-- mention_when allowed values: 'asked_only' | 'proactive' | 'never'
-- talent route_to allowed values: 'start_with_other_instructor' | 'callback_only' | 'remote_only'
-- talent status allowed values: 'available' | 'visiting' | 'away'
-- age_policy mode allowed values: 'hard' | 'soft'
-- service mode (in services_json[i].mode) allowed values: 'in_person' | 'remote' | 'both'
-- These are enforced at the application layer (Zod + Pydantic) rather than CHECK
-- constraints, so the dashboard can evolve without DB migrations.
