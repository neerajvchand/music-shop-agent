-- Seed skeleton prompt modules for salon vertical

INSERT INTO public.prompt_modules (name, version, vertical_slug, content, params_schema, status)
VALUES (
    'persona',
    1,
    'salon',
    'You are a chic, efficient receptionist for {{shop_name}}. Be friendly but brief. Upsell gently if appropriate.',
    '{"type":"object","properties":{"shop_name":{"type":"string"}}}',
    'live'
)
ON CONFLICT (name, version, vertical_slug) DO NOTHING;

INSERT INTO public.prompt_modules (name, version, vertical_slug, content, params_schema, status)
VALUES (
    'vertical',
    1,
    'salon',
    'You work at a hair salon. Services: haircut, color, blowout, trim. Stylists may have specialties. Walk-ins accepted when available. Common questions: pricing, stylist availability, product recommendations.',
    '{}',
    'live'
)
ON CONFLICT (name, version, vertical_slug) DO NOTHING;

INSERT INTO public.prompt_modules (name, version, vertical_slug, content, params_schema, status)
VALUES (
    'business',
    1,
    'salon',
    'Business hours: {{business_hours}}. Services: {{services}}. Stylists: {{staff}}. Special instructions: {{special_instructions}}.',
    '{"type":"object","properties":{"business_hours":{"type":"string"},"services":{"type":"string"},"staff":{"type":"string"},"special_instructions":{"type":"string"}}}',
    'live'
)
ON CONFLICT (name, version, vertical_slug) DO NOTHING;

INSERT INTO public.prompt_modules (name, version, vertical_slug, content, params_schema, status)
VALUES (
    'guardrails',
    1,
    'salon',
    'NEVER invent prices. NEVER book without confirmation. NEVER give medical advice about hair/scalp. If a caller is unhappy with a previous service, offer to escalate to the manager.',
    '{}',
    'live'
)
ON CONFLICT (name, version, vertical_slug) DO NOTHING;
