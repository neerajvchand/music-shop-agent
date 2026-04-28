# Voice Agent SaaS

Multi-tenant AI voice agent platform for SMBs (music shops, hair salons, notaries). Receives phone calls via Twilio, routes them to a Deepgram Voice Agent with **compositional prompt architecture**, and handles end-to-end booking via Google Calendar with SMS confirmations.

> **Differentiation:** We optimize for "the shop owner forgets we exist because bookings just happen." Not "look at my AI agent."

## Architecture

```
Phone Call → Twilio → POST /twilio/voice (TwiML)
                    → WS /twilio/ws (Media Stream)
                        ↕ bridge.py ↕
                    → WS Deepgram Voice Agent API
                        (STT: Nova-3, LLM: Gemini 2.5 Flash, TTS: Aura 2)
                              ↕
                    Compositional Prompt (persona → vertical → business → state → runtime → tools → guardrails → few_shot)
                              ↕
                    Booking State Machine → Google Calendar (atomic write)
                              ↕
                    SMS Confirmations + Owner Alerts + Daily Digest
```

## The Three Moats

1. **Compositional Prompt Architecture** — System prompt assembled from independently versioned modules. Patch once, roll out everywhere. No customer ever edits a prompt directly.
2. **Eval-Driven Improvement** — 30+ synthetic scenarios per vertical. Every real call scored by LLM judge. Auto-patch candidate generation when scores drop.
3. **Outcome-First Owner Surface** — Daily SMS digest is the primary UI. Dashboard only shows decisions that need action. Zero cognitive load.

## Setup

1. Copy `.env.example` to `.env` and fill in credentials
2. Install dependencies: `pip install -r requirements.txt`
3. Run Supabase migrations in order:
   ```
   supabase/migrations/001_create_shops.sql
   supabase/migrations/002_create_calls.sql
   supabase/migrations/003_seed_riyaaz.sql
   supabase/migrations/004_add_keyterms.sql
   supabase/migrations/005_add_farewell.sql
   supabase/migrations/006_create_prompt_system.sql
   supabase/migrations/007_create_bookings.sql
   supabase/migrations/008_create_integrations_and_events.sql
   supabase/migrations/009_create_evals.sql
   supabase/migrations/010_seed_prompt_modules.sql
   supabase/migrations/011_seed_salon_prompts.sql
   supabase/migrations/012_seed_eval_scenarios.sql
   ```
4. Run locally: `uvicorn app.main:app --reload`
5. Run tests: `pytest`

## Deploy to Railway

Push to GitHub — Railway auto-deploys via `railway.json`. Set all env vars from `.env.example` in Railway dashboard.

Configure Twilio number webhook to `https://<your-railway-url>/twilio/voice`.

## Tech Stack

- **Framework:** FastAPI + uvicorn
- **Voice:** Deepgram Voice Agent API (mulaw 8kHz, endpointing 300ms)
- **Telephony:** Twilio Programmable Voice + Media Streams + SMS
- **Database:** Supabase (Postgres)
- **Calendar:** Google Calendar API (OAuth per shop)
- **LLM:** Google Gemini 2.5 Flash (via Deepgram agent + direct for judge/synthesis)
- **TTS:** Deepgram Aura 2
- **Deployment:** Railway

## API Endpoints

### Voice
- `POST /twilio/voice` — Twilio webhook, returns TwiML
- `WS /twilio/ws` — Media stream bridge

### Owner Surface
- `GET /api/shops/{id}/digest` — Daily digest
- `POST /api/shops/{id}/digest/generate` — Generate digest on-demand
- `POST /api/shops/{id}/digest/send` — Send digest SMS
- `GET /api/shops/{id}/decisions` — List decisions inbox
- `POST /api/shops/{id}/decisions/{decision_id}/resolve` — Resolve a decision
- `GET /api/shops/{id}/drift` — Check drift alerts

### Evals
- `POST /api/evals/run` — Run eval suite for a module

## Project Structure

```
app/
  prompts/          # Compositional prompt architecture
    registry.py     # Load versioned modules from Supabase
    composer.py     # Assemble system prompt from CallContext
    state_machine.py # Conversation state machine
  booking/          # Booking sub-state-machine
    slots.py        # Vertical slot definitions
    state.py        # BookingDraft + BookingStateMachine
    persistence.py  # Draft save/load/resume
  calendar/         # Google Calendar integration
    client.py       # OAuth + API client
    availability.py # Free/busy + slot generation
    atomic.py       # Atomic booking transaction
  sms/              # Twilio SMS
    client.py       # Send SMS + owner alerts
    templates.py    # Message templates
  owner/            # Owner surface
    daily.py        # Daily summary generation
    decisions.py    # Decisions inbox
    drift.py        # Drift detection
  evals/            # Eval-driven improvement
    scenarios.py    # 15+ synthetic scenarios
    judge.py        # LLM judge with rubric
    harness.py      # Eval runner + promotion gating
  onboarding/       # Phone-based onboarding
    agent.py        # Onboarding agent config
    synthesizer.py  # Transcript → business config
  main.py           # FastAPI app
  bridge.py         # Twilio ↔ Deepgram bridge
  deepgram_client.py # Deepgram WS client
  shops.py          # Shop resolution
  config.py         # Settings
  call_logger.py    # Call logging
  supabase_client.py # Supabase client
  twilio_handlers.py # Twilio webhook handler
  audio.py          # Audio encode/decode
```

## Moats

See `MOATS.md` for detailed documentation on how each feature advances our competitive moats.
