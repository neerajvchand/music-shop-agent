-- Atomic booking guard: prevent double-booking the same slot
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_shop_scheduled_unique
  ON public.bookings(shop_id, scheduled_at);

-- Advisory lock helpers for token refresh (session-scoped, explicit release)
CREATE OR REPLACE FUNCTION try_integration_lock(p_shop_id text, p_provider text)
RETURNS boolean AS $$
BEGIN
  RETURN pg_try_advisory_lock(hashtext(p_shop_id || ':' || p_provider));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_integration_lock(p_shop_id text, p_provider text)
RETURNS void AS $$
BEGIN
  PERFORM pg_advisory_unlock(hashtext(p_shop_id || ':' || p_provider));
END;
$$ LANGUAGE plpgsql;
