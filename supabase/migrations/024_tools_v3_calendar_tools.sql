-- Migration 024: v3 tools module — calendar tools (UPSERT)
--
-- Replaces the v3 tools module body to add `check_availability` and
-- `create_booking`, both vertical-agnostic so the same module body serves
-- music-lessons, notary, and salon shops without changes.
--
-- `book_appointment` is kept as a deprecated alias for backward compatibility
-- with prompts in flight at deploy time. It maps to the same Python handler
-- as `create_booking` (see app/bridge.py). Drop in v4 once safe.
--
-- Idempotent: ON CONFLICT (name, version, vertical_slug) DO UPDATE.
-- params_schema is preserved as '{}' — the tools module declares its own
-- functions inline; CallContext doesn't substitute placeholders here.

INSERT INTO public.prompt_modules (name, version, vertical_slug, content, params_schema, status)
VALUES (
    'tools', 3, 'music_lessons',
    $TOOLS$
You have tools available. Only use them when appropriate.

<!-- TOOLS START -->
[
  {
    "name": "collect_slot",
    "description": "Record a piece of information the caller just gave you. Use this after the caller answers a question. Examples: after they say their name, their phone number, their preferred day, or their service choice.",
    "parameters": {
      "type": "object",
      "properties": {
        "slot_name": {"type": "string", "description": "e.g. service, customer_name, parent_name, student_age, experience_level, years_playing, formal_training, lesson_mode, preferred_days, callback_number, rental_type, rental_duration, change_request"},
        "value": {"type": "string"}
      },
      "required": ["slot_name", "value"]
    }
  },
  {
    "name": "confirm_slot",
    "description": "Mark a slot as confirmed after the caller verbally agrees it is correct. Use after you read back a phone number, name, or date and the caller says yes.",
    "parameters": {
      "type": "object",
      "properties": {
        "slot_name": {"type": "string"}
      },
      "required": ["slot_name"]
    }
  },
  {
    "name": "reject_slot",
    "description": "Use when the caller corrects or rejects a slot value you captured. Then re-collect it.",
    "parameters": {
      "type": "object",
      "properties": {
        "slot_name": {"type": "string"}
      },
      "required": ["slot_name"]
    }
  },
  {
    "name": "check_availability",
    "description": "Check available appointment slots for a service on a given date. Call before offering specific times to the caller. Returns slots in the shop's timezone.",
    "parameters": {
      "type": "object",
      "properties": {
        "service": {"type": "string", "description": "Service slug from the shop's catalog"},
        "date":    {"type": "string", "description": "ISO date YYYY-MM-DD"}
      },
      "required": ["service", "date"]
    }
  },
  {
    "name": "create_booking",
    "description": "Create a confirmed appointment. Call only after the caller has confirmed service, date, time, and contact info.",
    "parameters": {
      "type": "object",
      "properties": {
        "service":      {"type": "string"},
        "start_time":   {"type": "string", "description": "ISO 8601 with timezone offset"},
        "caller_name":  {"type": "string"},
        "caller_phone": {"type": "string"},
        "notes":        {"type": "string", "description": "Optional context (instructor preference, document type, special requests, etc.)"}
      },
      "required": ["service", "start_time", "caller_name", "caller_phone"]
    }
  },
  {
    "name": "book_appointment",
    "description": "Deprecated. Use create_booking instead. Kept for backward compatibility with prompts mid-deploy.",
    "parameters": {
      "type": "object",
      "properties": {
        "service":         {"type": "string"},
        "date":            {"type": "string"},
        "time":            {"type": "string"},
        "customer_name":   {"type": "string"},
        "customer_phone":  {"type": "string"},
        "notes":           {"type": "string"}
      },
      "required": ["service", "customer_name", "customer_phone"]
    }
  },
  {
    "name": "end_call",
    "description": "End the phone call ONLY after the caller has explicitly confirmed they have no further questions. Set caller_confirmed_done=true. Do NOT say anything in this turn — only call the function.",
    "parameters": {
      "type": "object",
      "properties": {
        "caller_confirmed_done": {"type": "boolean"},
        "reason": {"type": "string"}
      },
      "required": ["caller_confirmed_done", "reason"]
    }
  }
]
<!-- TOOLS END -->
$TOOLS$,
    '{}'::jsonb,
    'live'
)
ON CONFLICT (name, version, vertical_slug) DO UPDATE
    SET content = EXCLUDED.content,
        params_schema = EXCLUDED.params_schema,
        status = 'live',
        updated_at = now();

-- Validation queries (run manually after applying)
-- ------------------------------------------------
--
-- 1. Confirm the v3 tools row was updated:
-- SELECT name, version, updated_at, length(content) AS content_chars
-- FROM prompt_modules
-- WHERE vertical_slug = 'music_lessons' AND version = 3 AND name = 'tools';
--
-- 2. Confirm the new tool functions appear in the module body:
-- SELECT name, version,
--        content LIKE '%"name": "check_availability"%' AS has_check_availability,
--        content LIKE '%"name": "create_booking"%'    AS has_create_booking,
--        content LIKE '%"name": "book_appointment"%'  AS has_book_appointment_alias
-- FROM prompt_modules
-- WHERE vertical_slug = 'music_lessons' AND version = 3 AND name = 'tools';
--
-- Expected: all three booleans = true.
