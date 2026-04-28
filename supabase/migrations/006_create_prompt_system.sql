-- Compositional prompt architecture tables

-- Verticals define business categories (music_lessons, salon, notary, etc.)
CREATE TABLE IF NOT EXISTS public.verticals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    default_slots_json JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prompt modules: independently versioned, composable prompt segments
CREATE TABLE IF NOT EXISTS public.prompt_modules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    vertical_slug TEXT REFERENCES public.verticals(slug) ON DELETE SET NULL,
    content TEXT NOT NULL,
    params_schema JSONB, -- JSON Schema for runtime params this module accepts
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'deprecated')),
    eval_score NUMERIC(5,4), -- last eval score (0-1)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(name, version, vertical_slug)
);

-- Which modules are active for a given shop
CREATE TABLE IF NOT EXISTS public.shop_prompt_bindings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE CASCADE,
    module_name TEXT NOT NULL,
    module_version INTEGER NOT NULL,
    vertical_slug TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(shop_id, module_name)
);

-- Seed verticals
INSERT INTO public.verticals (slug, name, description, default_slots_json) VALUES
('music_lessons', 'Music Lessons', 'Private and group music instruction', '[
  {"name": "service", "required": true, "type": "select", "options": ["piano_lesson", "guitar_lesson", "vocal_lesson", "drum_lesson"]},
  {"name": "student_age", "required": false, "type": "number"},
  {"name": "instrument", "required": false, "type": "text"},
  {"name": "preferred_day", "required": true, "type": "text"},
  {"name": "preferred_time", "required": true, "type": "text"},
  {"name": "student_name", "required": true, "type": "text"},
  {"name": "student_phone", "required": true, "type": "phone"},
  {"name": "notes", "required": false, "type": "text"}
]'::jsonb),
('salon', 'Hair Salon', 'Hair styling and beauty services', '[
  {"name": "service", "required": true, "type": "select", "options": ["haircut", "color", "blowout", "trim"]},
  {"name": "stylist_preference", "required": false, "type": "text"},
  {"name": "preferred_day", "required": true, "type": "text"},
  {"name": "preferred_time", "required": true, "type": "text"},
  {"name": "client_name", "required": true, "type": "text"},
  {"name": "client_phone", "required": true, "type": "phone"},
  {"name": "notes", "required": false, "type": "text"}
]'::jsonb),
('notary', 'Notary Public', 'Document notarization services', '[
  {"name": "service", "required": true, "type": "select", "options": ["general_notary", "loan_signing", "mobile_notary"]},
  {"name": "document_type", "required": false, "type": "text"},
  {"name": "preferred_day", "required": true, "type": "text"},
  {"name": "preferred_time", "required": true, "type": "text"},
  {"name": "client_name", "required": true, "type": "text"},
  {"name": "client_phone", "required": true, "type": "phone"},
  {"name": "notes", "required": false, "type": "text"}
]'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- Add vertical reference to shops
ALTER TABLE public.shops
    ADD COLUMN IF NOT EXISTS vertical_slug TEXT REFERENCES public.verticals(slug) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS owner_notification_rules_json JSONB NOT NULL DEFAULT '{"first_time_customer": true, "high_value_service": true, "after_hours": true, "all_bookings": false}'::jsonb;
