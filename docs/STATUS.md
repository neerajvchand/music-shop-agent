# STATUS — music-shop-agent / Vanua.ai voice agent

_Reconstructed from the repo on 2026-06-04. Last commit: `e8a9217` (2026-05-11), ~3.5 weeks
stale. Branch `claude/friendly-euler-RTQ3m` is even with `main` (0 commits ahead). Working
tree clean._

> Read this top-to-bottom before touching anything — the README is materially out of date
> (see drift notes) and will mislead you about which stack is live.

---

## 1. Architecture (as-built)

There are **two voice bridges in the repo at once**, mid-migration:

| | Old (live) | New (Phase 1, not live) |
|---|---|---|
| Path | `app/` | `bridge/` |
| Stack | Python 3.11 / FastAPI / uvicorn | Node 18+ / TypeScript / Express |
| Voice API | **Deepgram** Voice Agent (Nova-3 STT, Gemini 2.5 Flash, Aura-2 TTS) | **xAI** Voice Agent (`grok-voice-think-fast-1.0`) |
| Audio | mulaw/PCMU 8kHz | PCMU 8kHz (identical, no transcode) |
| Deploy | Railway (root `Procfile` + `railway.json` → `uvicorn app.main:app`) | Railway service w/ root dir `/bridge` (**not yet provisioned per repo evidence**) |
| Prompt cap | 25k chars (Deepgram limit — drove migration 028 compaction) | none |

**The dashboard is a third, separate deployable** (`dashboard/`, Next.js 16 / React 19 /
Supabase / Vercel). It is *not* an operator dashboard in the "call list" sense — it is the
booking-tool backend + settings + integrations surface.

### Call path (new bridge, as written)

```
Caller → Twilio number (+15103301074)
  → POST /twiml            (bridge resolves shop by `To`, returns <Connect><Stream>)
  → WS  /twilio/ws/:callId (PCMU 8kHz; :callId minted per call in the TwiML handler)
        bridge/src/bridge/handler.ts  ── per-call orchestrator
          ├─ resolve shop (Supabase `shops`, by slug param then twilio_number)
          ├─ compose system prompt (prompts/composer + renderers + tools)
          ├─ XAIClient.connect()  → wait conversation.created
          ├─ XAIClient.configureSession() → wait session.updated
          ├─ wire audio/events, send greeting, trigger first response
          └─ 3 watchdogs: farewell · silence(30s) · hard-timeout(300s)
  → WS wss://api.x.ai/v1/realtime  (xAI / Grok)
```

**Function calls** (LLM → bridge) are **not** executed in the bridge. Three tools:
`end_call` (local state transition), `check_availability`, `create_booking`. The latter two
are **HMAC-SHA256 signed** and POSTed to the **Vercel dashboard** agent routes
(`/api/agent/check-availability`, `/api/agent/create-booking`). The dashboard owns Google
Calendar; the bridge never touches GCal directly. HMAC layout:
`payload = "{shop_id}:{timestamp_ms}"`, headers `x-shop-id` / `x-request-timestamp` /
`x-agent-signature`. Verifier: `dashboard/app/api/agent/_auth.ts` (5-min freshness window,
`timingSafeEqual`). The new TS signer (`bridge/src/http/hmac.ts`) is byte-compatible with the
old Python signer and pinned by `tests/hmac.test.ts` against Python-generated vectors. ✅

### Entry points & env

- **Bridge entry:** `bridge/src/index.ts` (Express + express-ws). `GET /health` returns
  `{status:"ok"}`. Started via `bridge/Procfile` → `npm start` → **`ts-node src/index.ts`**
  (runs TS directly in prod; README claims build-then-start — drift).
- **Bridge env** (`bridge/.env.example`): `XAI_API_KEY`, `XAI_API_URL`, `XAI_MODEL`,
  `PORT`, `HOSTNAME` (required — used to build the `wss://` Stream URL), `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `DASHBOARD_BASE_URL`, `AGENT_API_SECRET`, and four timeout
  knobs. Config is zod-validated and **fails fast** on missing required vars (`config.ts`). ✅
- **Dashboard env:** `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY`,
  `GOOGLE_CLIENT_ID/SECRET`, `AGENT_API_SECRET` (shared with bridge), `CRON_SECRET`.
- **Old Python env** (`.env.example` at root): Deepgram + Twilio + Google + Supabase.
- **Data layer is shared** — the new bridge reads the *same* `shops`/`calls`/`booking_drafts`
  rows the Python bridge uses, by design (`shops.ts` comment: "data-layer compatibility is
  required for the Phase 3 cutover"). 28 Supabase migrations, all Deepgram-era.

### Drift between docs and code (read this)

1. **README describes the OLD stack as if it's the whole product** — "Deepgram Voice Agent",
   "FastAPI + uvicorn", `pip install -r requirements.txt`, `app/bridge.py`. No mention of the
   Node/xAI bridge that is the actual active work. README is stale, not wrong-about-the-past.
2. **Root deploy config still deploys Python.** `railway.json` + root `Procfile` both run
   `uvicorn app.main:app`. Deploying "the repo" to Railway deploys the *old* bridge. The new
   bridge needs its **own** Railway service pointed at `/bridge`.
3. **`bridge/Procfile` runs `ts-node` in production**, while `bridge/README.md` step 3–4 says
   build (`tsc`) then `npm start`. The `start` script is `ts-node`, not `node dist/...`.
4. **`voice_id` mismatch.** The seeded Riyaaz shop has `voice_id = 'aura-2-minerva-en'`
   (a *Deepgram* voice; migration 003). The new bridge passes `shop.voice_id || "rex"`
   straight to xAI — so it would hand xAI a Deepgram voice name. The `|| "rex"` fallback
   only triggers on empty, and it isn't empty. **A voice remap is required before any real
   xAI call.**
5. **TwiML omits caller identity.** `twiml.ts` sends only `<Parameter name="shop">`, but
   `handler.ts` reads `customParameters.to` / `.from`. So `callerPhone` is always `null` —
   logged calls and `create_booking` get no caller number from the stream. Repair before launch.

---

## 2. State — done / half-done / next step

### ✅ Done (in code, on `main`, unit-tested)
- Full Node/xAI bridge **Phase 1** scaffold merged via PR #11: config, logger, state machine,
  async-event primitive, HMAC, xAI client (connect/configure/audio/function/transcript/error),
  Twilio adapter + TwiML, prompt composer/renderers/tools, Supabase wrappers
  (shops/calls/prompt-modules/booking-drafts), three watchdogs, function dispatch.
- Tests present and scoped to pure logic: `async-event`, `farewell`, `hmac` (cross-language
  vectors), `renderers` (slug-exposure), `state-machine`. (Run not executed here — no
  `node_modules`; `package-lock.json` is gitignored, see risks.)
- Old Python/Deepgram bridge is the **production-live** system (one live customer "Riyaaz",
  28 migrations of real-call prompt tuning, two-step end_call, farewell fixes, booking flow).
- Dashboard agent routes + HMAC verifier + Google Calendar integration + settings UI.

### 🟡 Half-done (started, NOT verified/deployed)
- **New bridge is not deployed.** No evidence of a live Railway service for `/bridge`: no
  prod URL committed, `HOSTNAME` unset, root deploy config still points at Python, and
  `bridge/README.md` describes the Railway setup as a *to-do checklist* ("Create a new Railway
  service… Note the assigned URL; that's what Twilio webhooks will point to in Phase 3").
  **Assessment: initiated/coded, not live, never received a real call.**
- **Twilio is still pointed at the Python bridge.** No cutover. The xAI bridge has handled
  zero production traffic by design (Phases 1–2 run alongside; cutover is Phase 3).
- **Dashboard ↔ bridge wiring is one-directional and untested end-to-end on xAI.** The bridge
  → dashboard direction (`DASHBOARD_BASE_URL` → Vercel) is coded; it has never been exercised
  by the xAI bridge against the live dashboard.
- `package-lock.json` deliberately gitignored "Phase 1 only" (proxy rejected the push) →
  non-deterministic Railway builds. Explicit `TODO(phase-3)` to re-commit it.
- Recording disclosure hard-coded `false` in `twiml.ts`; Phase 2 was to add a per-shop column.

### ▶️ Single next blocking step to get the bridge into production
**Provision the Railway service for `/bridge` and bring up one healthy instance with real env
vars, then place ONE end-to-end test call through it** (separate Twilio TEST number → bridge
`/twiml`). Everything else (voice remap, caller-id param, lock file, cutover) is downstream of
having a running, reachable instance to test against. Until `HOSTNAME` is set and `/health` is
green on a public URL, nothing else can be validated.

---

## 3. Risks (found in code)

**Blocking for production:**
- **No bridge-initiated call termination.** `end_call`, silence-timeout, and hard-timeout all
  only transition to `AWAITING_FAREWELL` and speak a farewell. Nothing hangs up the Twilio
  call or closes the xAI socket — `xai.close()` runs *only after the caller hangs up*
  (`handler.ts` awaits `twilioWs 'close'`). A caller who stays silent keeps the xAI session +
  Twilio minutes open until they physically hang up. Direct cost + dead-air bug. Needs a
  Twilio REST `update(status:'completed')` or a `<Hangup>` redirect after the farewell drains.
- **No xAI reconnect, and `onClose` is never wired.** `XAIClient.onClose` exists but
  `handler.ts` never registers it. A mid-call xAI WS drop (clean close / 1006) is invisible to
  the bridge: no caller notification, no state transition. Result is silent dead air until the
  30s silence watchdog fires a farewell into a dead socket (send is dropped & logged),
  `response.done` never arrives, 8s safety timeout elapses, call hangs. Only `error` *events*
  (not socket closes) trigger the `AWAITING_FAREWELL` fallback.
- **`voice_id` is a Deepgram value** for the only live shop (see drift #4) — first real xAI
  call would likely error or fall back oddly at `session.update`.
- **Caller phone never captured** (drift #5) — bookings/call logs lose the number.

**Security / ops:**
- **No Twilio request-signature validation** on `/twiml` or `/call-status`. The webhooks are
  unauthenticated; anyone who learns the URL can POST a `To` and open a media-stream slot.
  Add Twilio `X-Twilio-Signature` validation (the `twilio` SDK is already a dependency).
- **Two open Vercel security-bot PRs (#1, #2)** patch a **critical Next.js RCE**
  (CVE-2025-55182 / CVE-2025-66478, React Server Components insecure deserialization,
  unauthenticated RCE). Dashboard is on `next@^16.2.4`. **Unmerged.** This affects the live
  dashboard that holds the booking routes and Google tokens — triage promptly.
- **HMAC has no nonce/replay cache** — only a 5-min freshness window. Acceptable for now;
  a replayed signed request within 5 min would pass. Low priority given the threat model.
- **`package-lock.json` gitignored** → non-reproducible bridge builds on Railway. Re-commit
  before cutover (the stated Phase-3 TODO).
- No secrets found hardcoded in source — all via env (`.env*` gitignored). ✅ Good.

**Lower severity:**
- `ts-node` in production (slower cold start, dev dep in the prod path) — prefer `tsc` build +
  `node dist`.
- Greeting is triggered by a `user`-role "Greet the caller now…" message; if xAI ignores it
  the call opens with silence (no fallback greeting).

---

## 4. Market position

> **Web access: YES.** Searched 2026-06; sources cited below. Numbers are current, not training-data.

**Current state being assessed:** flat-rate **$199/mo** standard, **$149** founding;
~73–80% gross margin at xAI ~$0.05/min; **one live customer + one onboarding**;
done-for-you, vertical-flavored (music lessons / salons / notaries).

### Where the market is in mid-2026
- AI receptionist pricing has settled into three bands: **budget** ($25–$65/mo, call-capped),
  **flat-rate** ($149–$299/mo, "unlimited" + booking + CRM), and **human-hybrid**
  ($255–$1,275+/mo with $7–$11 per-call overages). Most SMBs land $99–$299/mo all-in.
- **The $199 flat-rate / unlimited tier is now the modal price, not a differentiator.**
  NextPhone advertises the *identical* "$199/mo flat, unlimited calls, no hidden fees"
  positioning. Vanua's headline price has no pricing moat left — it's the going rate.
- **Infra is commoditized.** Retell PAYG from ~$0.07/min, Vapi ~$0.05/min orchestration fee
  (~$0.14–0.15 all-in), Synthflow ~$0.08–0.16/min, Bland $0.11–0.14/min. Anyone can stand up
  a comparable bridge on these in days. xAI at ~$0.05/min gives a real *cost* edge today, but
  it's a supplier choice, not a barrier — and it's a single-supplier dependency.
- **Direct done-for-you competitors** (AuraDesk and peers) pitch the same bundle: 24/7 voice
  agent, multilingual, Google Calendar booking + SMS confirmations, lead tagging, 7-day trial.
  AuraDesk specifically advertises 50+ languages, real-time GCal booking, SMS confirms — i.e.
  feature parity with Vanua's surface-level pitch.
- **Vertical players exist** (e.g. Slang.ai for hospitality), but no dominant
  done-for-you brand owns music schools / lesson studios / salons specifically. That niche is
  still open — which is the opportunity *and* the warning (open because it's small).

### Critical read — defensible vs. copyable in a week

**Genuinely defensible (if executed):**
- **The compounding data loop**, *if it actually runs.* MOATS.md's eval-driven, per-call-judged,
  auto-patch loop over a single vertical's real calls is the one thing that gets better with
  time and is annoying to clone. **Caveat: it's largely aspirational in the current tree** —
  the live system is the Python bridge; the eval harness (`app/evals/`) exists but there's no
  evidence it's gating prompts on real traffic. A moat you describe but don't run is not a moat.
- **Compositional prompt architecture** as an *operational* advantage: patch once, roll out to
  every shop in a vertical. Real leverage at 50+ shops; near-zero benefit at 1–2. Its value is
  latent until there's fleet scale.
- **"Outcome-first" / SMS-digest framing** — defensible only as brand + taste, not tech.

**Copyable in a week:**
- The bridge itself (Twilio ↔ realtime voice API ↔ GCal booking). It's a known pattern; xAI's
  API is OpenAI-Realtime-compatible, so even the provider lock-in is shallow.
- $199 flat-rate unlimited — already matched (NextPhone).
- Multilingual, SMS confirmations, calendar booking, lead tagging — table stakes; AuraDesk and
  every platform ship these.
- Vertical "flavoring" via prompt content — a competitor copies your prompts by calling your
  own number a few times.

**Bottom line:** Today this is a **well-engineered instance of a commoditized product at the
commodity price**, with **one customer**. The only durable edge is the
data/eval flywheel over a chosen vertical — and that edge is currently *written down, not
running*. The strategic risk isn't a competitor's tech; it's that nothing here compounds until
(a) the eval loop actually gates production prompts on real calls, and (b) there are enough
shops in one vertical for compositional patching to matter. Price and features won't carry it.

### Sources
- https://www.getnextphone.com/blog/ai-receptionist-cost
- https://agentzap.ai/blog/ai-receptionist-pricing-complete-cost-guide-2025
- https://ainora.lt/blog/ai-receptionist-pricing-2026
- https://klariqo.com/blog/voice-ai-cost-per-minute/
- https://www.retellai.com/blog/synhtflow-ai-review
- https://www.auradesk.vip/
- https://slang.ai/ (referenced via getvoip/oncehub vertical roundups)
</content>
