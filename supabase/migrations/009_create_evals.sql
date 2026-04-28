-- Eval system tables

CREATE TABLE IF NOT EXISTS public.eval_scenarios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vertical_slug TEXT NOT NULL REFERENCES public.verticals(slug) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    difficulty TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
    caller_persona TEXT NOT NULL,
    objective TEXT NOT NULL, -- what the caller is trying to accomplish
    script_hint TEXT, -- guidance for simulated caller
    success_criteria_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    tags TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.eval_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_name TEXT NOT NULL,
    module_version INTEGER NOT NULL,
    vertical_slug TEXT NOT NULL REFERENCES public.verticals(slug) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed')),
    overall_score NUMERIC(5,4),
    scenarios_total INTEGER NOT NULL DEFAULT 0,
    scenarios_passed INTEGER NOT NULL DEFAULT 0,
    results_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

-- Call quality scores (real call evaluation)
CREATE TABLE IF NOT EXISTS public.call_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_sid TEXT NOT NULL,
    shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
    rubric_version INTEGER NOT NULL DEFAULT 1,
    overall_score NUMERIC(5,4),
    dimension_scores_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- dimensions: slot_collection, confirmation, scope_adherence, tone, efficiency
    flagged BOOLEAN NOT NULL DEFAULT false,
    flag_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_scores_shop ON public.call_scores(shop_id, created_at);
