# music-shop-agent bridge (Node.js + xAI)

Voice agent bridge service: Twilio Media Streams to xAI Voice Agent API.

This service replaces the Python Deepgram bridge (`../app/`) after Phase 3 cutover. During Phases 1 and 2 it runs alongside the Python bridge but does not handle production traffic.

## Architecture

```
Phone caller
   |
   v
Twilio (+15103301074)
   |  HTTP webhook (/twiml)
   |  WebSocket (/twilio/ws/:callId, audio/x-mulaw 8kHz)
   v
This bridge (Node.js, Railway)
   |  WebSocket (wss://api.x.ai/v1/realtime, audio/pcmu)
   v
xAI Voice Agent API (Grok)
```

Function calls from the LLM are signed with HMAC-SHA256 and dispatched to the Vercel dashboard agent routes (`/api/agent/check-availability`, `/api/agent/create-booking`). The bridge never talks to Google Calendar directly.

## Local development

```
cp .env.example .env
# fill in XAI_API_KEY, SUPABASE_*, AGENT_API_SECRET
npm install
npm run dev
```

Expose locally with ngrok: `ngrok http 8080`. Point a Twilio TEST number's voice webhook at `https://<your-ngrok>.ngrok.io/twiml`.

## Tests

```
npm test
```

## Railway deployment

1. Create a new Railway service in the existing project
2. Connect to this GitHub repo with root directory `/bridge`
3. Build: `npm install && npm run build`
4. Start: `npm start`
5. Set env vars (see `.env.example`)
6. Note the assigned URL; that's what Twilio webhooks will point to in Phase 3

The Python bridge service keeps running on its own Railway service. No production traffic is moved during Phases 1 or 2.

## Key design decisions

**Eager bridge-driven farewell.** When the LLM calls `end_call`, the bridge speaks the configured shop farewell deterministically via a `conversation.item.create` (system role) + `response.create`. Single watchdog on `response.done`. The LLM is not asked to generate a farewell turn (avoids the dead-air-then-double-farewell pattern observed on Deepgram).

**Slug-exposure in `services_text`.** Renderer outputs `[slug] Display Name, ...` so the LLM passes verbatim slugs to tool functions instead of guessing. Prevents a slug-mismatch failure mode that surfaced in pre-launch testing.

**Three bridge states only.** `ACTIVE_CONVERSATION` -> `AWAITING_FAREWELL` -> `CLOSING`. Caller audio flows through until `CLOSING`, mirroring the Python bridge fix that resolved barge-in regressions.

**xAI vs Deepgram.** Cheaper per minute, no 25k char prompt cap, OpenAI Realtime API compatible (portable to other providers). Trade-off: smaller ecosystem, less battle-tested protocol surface; we own more of the resilience.
