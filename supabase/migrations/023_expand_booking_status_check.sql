-- Migration 023: expand bookings.status CHECK constraint
--
-- Background
-- ----------
-- The original CHECK constraint from 007_create_bookings.sql allowed only
-- 'confirmed', 'cancelled', 'completed', 'no_show'. The Python atomic_book
-- code (now deprecated as of Phase 2) inserted rows with status='reserved',
-- which silently violated the constraint and failed every insert.
--
-- The Vercel /api/agent/create-booking route's atomic guard pattern needs:
--   * 'reserved'        — inserted before Google Calendar write attempt
--   * 'confirmed'       — set after Google write succeeds (real bookings)
--   * 'test_confirmed'  — set when shop.test_mode = true (no Google write)
--   * 'pending_sync'    — Google write failed; manual remediation later
--
-- Pre-flight validation
-- ---------------------
-- Run this BEFORE applying to surface any pre-existing drift:
--
--     SELECT status, count(*) FROM bookings GROUP BY status ORDER BY count DESC;
--
-- Expected: empty result set, or only the original four values present.
-- Any rows with unexpected values would block the new constraint and need
-- investigation.

ALTER TABLE public.bookings
    DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE public.bookings
    ADD CONSTRAINT bookings_status_check
    CHECK (status IN (
        'reserved',
        'confirmed',
        'test_confirmed',
        'pending_sync',
        'cancelled',
        'completed',
        'no_show'
    ));

-- Post-flight validation
-- ----------------------
-- After applying, verify the constraint is updated:
--
--     SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--     WHERE conrelid = 'bookings'::regclass AND contype = 'c';
--
-- Expected: bookings_status_check appears with all 7 allowed values.
