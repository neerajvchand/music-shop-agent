-- Booking system tables

-- Bookings: confirmed appointments
CREATE TABLE IF NOT EXISTS public.bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
    call_sid TEXT,
    vertical_slug TEXT NOT NULL,
    service TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    duration_min INTEGER NOT NULL DEFAULT 60,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    customer_name TEXT,
    customer_phone TEXT,
    customer_email TEXT,
    notes TEXT,
    extra_slots_json JSONB NOT NULL DEFAULT '{}'::jsonb, -- vertical-specific slots
    gcal_event_id TEXT,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
    reminder_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Booking drafts: in-progress bookings, resumable after call drops
CREATE TABLE IF NOT EXISTS public.booking_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
    call_sid TEXT NOT NULL,
    caller_phone TEXT,
    vertical_slug TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'slot_capture' CHECK (state IN ('greeting', 'discovery', 'scheduling', 'slot_capture', 'confirming', 'farewell', 'recovery')),
    captured_slots_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    confirmed_slots_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    pending_slot TEXT,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(shop_id, call_sid)
);

-- Index for resuming dropped calls
CREATE INDEX IF NOT EXISTS idx_booking_drafts_call_sid ON public.booking_drafts(call_sid);
CREATE INDEX IF NOT EXISTS idx_booking_drafts_expires ON public.booking_drafts(expires_at);

-- Index for shop bookings lookup
CREATE INDEX IF NOT EXISTS idx_bookings_shop_scheduled ON public.bookings(shop_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_bookings_customer_phone ON public.bookings(customer_phone);
