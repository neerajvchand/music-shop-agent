-- Operator-only integration event log
CREATE TABLE IF NOT EXISTS public.integration_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integration_events_shop_provider_time
  ON public.integration_events(shop_id, provider, occurred_at DESC);

-- Service-role only. Owners cannot read.
ALTER TABLE public.integration_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY integration_events_deny_all
  ON public.integration_events
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);
