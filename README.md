# Music Shop Voice Agent

Multi-tenant AI voice agent platform for music shops. Receives phone calls via Twilio, routes them to a Deepgram Voice Agent configured per-shop from Supabase, and logs call records.

## Phase 1

Deployable FastAPI bridge: Twilio Media Streams ↔ Deepgram Voice Agent API. First tenant: Riyaaz Music Shop. Adding a new shop is a data-only change (INSERT into `shops` table).

## Architecture

```
Phone Call → Twilio → POST /twilio/voice (TwiML)
                    → WS /twilio/ws (Media Stream)
                        ↕ bridge.py ↕
                    → WS Deepgram Voice Agent API
                        (STT: Nova-3, LLM: Gemini 2.5 Flash, TTS: Aura 2)

Call record → Supabase (calls table)
```

## Setup

1. Copy `.env.example` to `.env` and fill in credentials
2. Install dependencies: `pip install -r requirements.txt`
3. Run Supabase migrations (in order):
   - `supabase/migrations/001_create_shops.sql`
   - `supabase/migrations/002_create_calls.sql`
   - `supabase/migrations/003_seed_riyaaz.sql` (update greeting/system_prompt first)
4. Run locally: `uvicorn app.main:app --reload`
5. Run tests: `pytest`

## Deploy to Railway

Push to GitHub — Railway auto-deploys via `railway.json`. Set all env vars from `.env.example` in Railway dashboard.

Configure Twilio number webhook to `https://<your-railway-url>/twilio/voice`.

## Tech Stack

- **Framework:** FastAPI + uvicorn
- **Voice:** Deepgram Voice Agent API (mulaw 8kHz, no format conversion)
- **Telephony:** Twilio Programmable Voice + Media Streams
- **Database:** Supabase (Postgres)
- **LLM:** Google Gemini 2.5 Flash (via Deepgram agent)
- **TTS:** Deepgram Aura 2
- **Deployment:** Railway
