# Moats Documentation

Every PR must name which moat it advances and explain how it would be hard for a horizontal competitor (Vapi, Retell, Synthflow, Bland) to replicate.

---

## Moat 1: Compositional Prompt Architecture

**What it is:**
The system prompt is assembled at call-time from independently versioned modules stored in Supabase:
`persona → vertical → business → state → runtime → tools → guardrails → few_shot`.

**Why it matters:**
- When we discover that the `scheduling` state mishears phone numbers 12% of the time across all music-lesson shops, we patch the `state_module(scheduling)` once and it rolls out everywhere.
- No customer ever edits a prompt directly. They only approve patches the system suggests.
- Tool descriptions are first-class prompts with disambiguation examples, not bare JSON schemas.

**Hard to replicate:**
Competitors expose a single monolithic prompt text box. Their customers customize it, making it impossible to push global improvements without breaking individual configs. Their architecture is not compositional by design — it's a single string.

**PRs advancing this moat:**
- `prompts/` package: registry, composer, state machine
- `prompt_modules` and `shop_prompt_bindings` tables
- Seeded modules for music_lessons and salon verticals

---

## Moat 2: Eval-Driven, Self-Improving Prompts

**What it is:**
- Every prompt module change runs against a synthetic call suite (30+ scenarios per vertical) before shipping.
- Every real call is scored by an LLM judge on 5 dimensions.
- When a state's score drops below threshold for a vertical, the system auto-generates a candidate patch and queues it for human review.

**Why it matters:**
After 90 days, our music-lesson prompt is meaningfully better than any competitor's because it has been touched by 10,000 calls of feedback. This compounds.

**Hard to replicate:**
Competitors have no systematic eval loop. They rely on anecdotal customer feedback and manual QA. Building an eval harness with simulated callers, rubrics, and auto-patching requires rethinking their entire prompt layer from the ground up.

**PRs advancing this moat:**
- `evals/` package: scenarios, judge, harness
- `call_scores` and `eval_runs` tables
- CI gating: module cannot be promoted to `live` without passing eval suite

---

## Moat 3: Outcome-First Owner Surface

**What it is:**
The shop owner's primary interface is a daily SMS digest, not a dashboard:
> "Riyaaz: 4 calls today. 3 booked. 1 caller asked about guitar repair — you don't offer it. Reply 1 to add the service."

The web dashboard surfaces only:
- Decisions needed (approve/add/ignore)
- Drift alerts (booking rate dropped)
- One-tap prompt patches

No call list as home screen. No knobs. The owner can ignore the product for two weeks and miss nothing.

**Why it matters:**
SMB owners don't want another dashboard. They want outcomes. Our zero-cognitive-load surface is the product's marketing — owners tell other owners about "the text I get every morning."

**Hard to replicate:**
Competitors optimize for "look at my AI agent" — they show transcripts, call lists, prompt editors, and minutes-used counters. Their product is the dashboard. Ours is the outcome. They would have to kill their primary UI to compete.

**PRs advancing this moat:**
- Owner surface APIs: `/api/shops/{id}/digest`, `/decisions`, `/drift`
- Daily summary generation and SMS delivery
- Decision inbox with structured types

---

## Phase 3 — Calendar Arms (Differentiated)

**Not:** `book_appointment(date, time)` as a single tool call.
**Instead:** Booking is a sub-state-machine inside `scheduling` with per-slot extraction, confirmation, and repair prompts.
- Atomic write: check → reserve (30s TTL) → verbal confirm → write to Google Calendar → commit.
- No double-bookings ever. If GCal write fails, reservation auto-expires.
- Draft bookings survive mid-call drops; resumable for 10 minutes.

**Moat:** Competitors treat booking as a simple function call. We treat it as a distributed transaction with conversational repair at every step.

---

## Phase 4 — Confirmation Loop (Differentiated)

**Not:** "You're booked" SMS.
**Instead:** Two-sided, feedback-bearing confirmation:
- Customer gets confirmation + one-tap reschedule/cancel link.
- Owner gets silent-by-default notifications (only first-time, high-value, after-hours).
- 24-hour reminder with reply-to-confirm.
- No-show feedback loop: owner marks no-show → flagged on next call → agent asks for deposit.

**Moat:** Competitors send one SMS and call it done. We build a closed loop that improves the product over time.

---

## Phase 5 — Onboarding (Differentiated)

**Not:** Web form with 12 fields.
**Instead:** Phone-based onboarding. Owner calls a number, the onboarding agent interviews them, and the output is a structured config blob + a 5-call eval.

The act of onboarding IS a demo of the product.

**Moat:** Competitors have onboarding friction (forms, API keys, prompt editing). Our onboarding is a phone call — the same interface as the product. This is both easier and self-demonstrating.
