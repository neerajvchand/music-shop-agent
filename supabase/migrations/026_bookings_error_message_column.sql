-- Migration 026: bookings.error_message column for failure observability
--
-- Failed booking attempts (calendar API errors, sync failures, etc.) can now
-- record their error reason directly on the row rather than only surviving in
-- Vercel function logs. Pure additive change: nullable column, zero risk to
-- existing rows. The dashboard "Needs Attention" view (phase-3b) will read
-- this column to show owners actionable retry information.

ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS error_message TEXT;

COMMENT ON COLUMN public.bookings.error_message IS
'Populated when a booking encounters an error (calendar API failure, sync failure, etc.). NULL for successful bookings.';
