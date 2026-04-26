# Phase 2.5: End-of-Call Architecture (Approach E)

**Goal:** Replace the current system-baked farewell with a two-turn close pattern. The LLM signals intent via `end_call`, the bridge holds the call open in a dedicated `AWAITING_FAREWELL` state, the LLM speaks the farewell as its next turn, and the bridge closes on `AgentAudioDone`.

**Why:** voice consistency, contextual warmth, faster perceived disconnect, no more "weird 4.5s pause then hangup."

---

## Architectural Summary

### State Machine

```
ACTIVE_CONVERSATION
        |
        | (caller confirms done; LLM emits end_call with caller_confirmed_done=true)
        |
        v
AWAITING_FAREWELL
        |
        | (AgentAudioDone fires after farewell speech)  OR  (8s safety timer fires)
        |
        v
   CLOSING
        |
        | (400ms grace period for Twilio buffer flush)
        |
        v
[WebSocket closed, call ends]
```

### Critical behaviors per state

**ACTIVE_CONVERSATION** — current behavior. Caller audio forwarded to Deepgram. All events processed normally.

**AWAITING_FAREWELL** — entered after valid `end_call`. Caller audio is **hard-gated** (no longer forwarded to Deepgram). Bridge waits for `AgentAudioDone` indicating farewell speech finished. 8-second safety timer running. If safety timer fires, bridge injects a system-baked farewell as fallback and waits for that `AgentAudioDone`.

**CLOSING** — 400ms grace period. WebSocket closes.

### Key contract changes

- `end_call` handler **no longer injects farewell**. It only validates, responds, and transitions state.
- LLM is instructed via system prompt that its **next response after end_call is the farewell**.
- Caller audio is hard-gated to prevent stray sounds reopening conversation.
- Disconnect is event-driven on `AgentAudioDone`, not timer-based.
- Fallback farewell only fires on safety-timer expiry.

---

## Implementation: app/bridge.py

### State enum

Add at top of `bridge.py`:

```python
from enum import Enum

class CallState(Enum):
    ACTIVE_CONVERSATION = "active_conversation"
    AWAITING_FAREWELL = "awaiting_farewell"
    CLOSING = "closing"
```

### Constants update

Replace the existing constants:

```python
SILENCE_TIMEOUT = 30           # unchanged
GOODBYE_DRAIN_MS = 400         # was 4500 — now just buffer flush
FAREWELL_SAFETY_TIMEOUT = 8    # new: max wait for LLM-spoken farewell
```

### CallStateTracker class

New helper to encapsulate state and provide observability via logging:

```python
class CallStateTracker:
    def __init__(self, call_sid: str, logger):
        self.call_sid = call_sid
        self.state = CallState.ACTIVE_CONVERSATION
        self._logger = logger
    
    def transition_to(self, new_state: CallState) -> None:
        old = self.state
        self.state = new_state
        self._logger.info(
            "State transition: %s -> %s (call=%s)",
            old.value, new_state.value, self.call_sid,
        )
    
    def is_active(self) -> bool:
        return self.state == CallState.ACTIVE_CONVERSATION
    
    def is_awaiting_farewell(self) -> bool:
        return self.state == CallState.AWAITING_FAREWELL
    
    def is_closing(self) -> bool:
        return self.state == CallState.CLOSING
```

### Update _twilio_to_deepgram

Hard-gate caller audio when not in ACTIVE_CONVERSATION:

```python
async def _twilio_to_deepgram(
    twilio_ws: WebSocket,
    deepgram: DeepgramAgentClient,
    silence_tracker: SilenceTracker,
    call_state: CallStateTracker,
) -> None:
    try:
        while True:
            raw = await twilio_ws.receive_text()
            msg = json.loads(raw)
            event = msg.get("event")
            
            if event == "media":
                # HARD GATE: only forward audio during active conversation
                if not call_state.is_active():
                    continue
                audio_bytes = decode_twilio_media(msg)
                await deepgram.send_audio(audio_bytes)
            
            elif event == "stop":
                logger.info("Twilio stream stopped (call=%s)", call_state.call_sid)
                return
    except WebSocketDisconnect:
        logger.info("Twilio disconnected (call=%s)", call_state.call_sid)
```

### Update _deepgram_to_twilio

Major refactor to handle the new state machine. Key changes:

1. Track `agent_audio_done_event` alongside `end_call_event`
2. On `UserStartedSpeaking`: only mark silence activity if state is active
3. On `FunctionCallRequest` with valid `end_call`: send response, transition to AWAITING_FAREWELL, start safety timer (no farewell injection)
4. On `AgentAudioDone`: if in AWAITING_FAREWELL, set agent_audio_done_event

Pseudocode for the handler updates:

```python
elif event_type == "UserStartedSpeaking":
    if call_state.is_active():
        silence_tracker.mark_activity()
    # ignored otherwise — caller audio is gated anyway, but defensive

elif event_type == "FunctionCallRequest":
    for fn in event.get("functions", []):
        fn_name = fn.get("name")
        fn_id = fn.get("id", "")
        is_client_side = fn.get("client_side", False)
        
        if fn_name == "end_call" and is_client_side:
            args_str = fn.get("arguments", "{}")
            try:
                args = json.loads(args_str)
            except json.JSONDecodeError:
                args = {}
            
            confirmed = args.get("caller_confirmed_done", False)
            reason = args.get("reason", "no reason given")
            
            if not confirmed:
                logger.warning(
                    "end_call rejected: caller_confirmed_done=false (reason=%s, call=%s)",
                    reason, call_state.call_sid,
                )
                await deepgram.send_function_call_response(
                    function_id=fn_id,
                    name="end_call",
                    result='{"status": "ignored", "reason": "caller_confirmed_done must be true"}',
                )
                continue  # stay in active state
            
            # Valid end_call — transition to awaiting farewell
            logger.info(
                "end_call accepted (reason=%s, call=%s)",
                reason, call_state.call_sid,
            )
            await deepgram.send_function_call_response(
                function_id=fn_id,
                name="end_call",
                result='{"status": "accepted, deliver farewell now"}',
            )
            call_state.transition_to(CallState.AWAITING_FAREWELL)
            return  # exit this handler iteration
        else:
            logger.warning("Unhandled FunctionCallRequest: %s", fn_name)

elif event_type == "AgentAudioDone":
    if call_state.is_awaiting_farewell():
        logger.info("AgentAudioDone received in AWAITING_FAREWELL (call=%s)", call_state.call_sid)
        agent_audio_done_event.set()
```

### New _farewell_safety_watchdog task

```python
async def _farewell_safety_watchdog(
    call_state: CallStateTracker,
    deepgram: DeepgramAgentClient,
    shop: Shop,
    agent_audio_done_event: asyncio.Event,
) -> None:
    """If AWAITING_FAREWELL persists past safety timeout, inject system farewell."""
    # Wait for state to enter AWAITING_FAREWELL
    while not call_state.is_awaiting_farewell():
        await asyncio.sleep(0.2)
        if call_state.is_closing():
            return  # call already wrapping up via another path
    
    # Now in AWAITING_FAREWELL — start the safety timer
    try:
        await asyncio.wait_for(
            agent_audio_done_event.wait(),
            timeout=FAREWELL_SAFETY_TIMEOUT,
        )
        logger.info("Farewell completed via LLM (call=%s)", call_state.call_sid)
    except asyncio.TimeoutError:
        logger.warning(
            "LLM farewell did not complete within %ds — injecting fallback (call=%s)",
            FAREWELL_SAFETY_TIMEOUT, call_state.call_sid,
        )
        await deepgram.inject_goodbye(shop.farewell)
        # Wait for the injected farewell to finish playing
        try:
            await asyncio.wait_for(agent_audio_done_event.wait(), timeout=FAREWELL_SAFETY_TIMEOUT)
        except asyncio.TimeoutError:
            logger.error("Even fallback farewell did not complete (call=%s)", call_state.call_sid)
```

### Update _silence_watchdog

Silence watchdog should only fire in ACTIVE_CONVERSATION, and when it fires, transition to AWAITING_FAREWELL using the same flow:

```python
async def _silence_watchdog(
    silence_tracker: SilenceTracker,
    deepgram: DeepgramAgentClient,
    shop: Shop,
    call_state: CallStateTracker,
) -> None:
    while call_state.is_active():
        await asyncio.sleep(5)
        if silence_tracker.seconds_since_activity() >= SILENCE_TIMEOUT:
            logger.info("Silence timeout reached, ending call (call=%s)", call_state.call_sid)
            call_state.transition_to(CallState.AWAITING_FAREWELL)
            await deepgram.inject_goodbye(shop.farewell)
            return  # safety watchdog will pick up from here
```

### Refactor run_bridge orchestration

Pull state, agent_audio_done_event, and the new farewell watchdog into the asyncio.wait. Replace the current end_call_event flow:

```python
async def run_bridge(twilio_ws: WebSocket, ...):
    # ... existing setup ...
    
    call_state = CallStateTracker(call_sid=call_sid, logger=logger)
    silence_tracker = SilenceTracker()
    agent_audio_done_event = asyncio.Event()
    
    twilio_task = asyncio.create_task(
        _twilio_to_deepgram(twilio_ws, deepgram, silence_tracker, call_state)
    )
    deepgram_task = asyncio.create_task(
        _deepgram_to_twilio(
            deepgram, twilio_ws, stream_sid, transcript_parts,
            call_state, silence_tracker, agent_audio_done_event,
        )
    )
    timeout_task = asyncio.create_task(
        _call_timeout(MAX_CALL_DURATION, twilio_ws, deepgram, stream_sid, call_state)
    )
    silence_task = asyncio.create_task(
        _silence_watchdog(silence_tracker, deepgram, shop, call_state)
    )
    farewell_task = asyncio.create_task(
        _farewell_safety_watchdog(call_state, deepgram, shop, agent_audio_done_event)
    )
    
    # Wait for either the farewell flow to complete, or one of the network tasks to die
    done, pending = await asyncio.wait(
        [twilio_task, deepgram_task, timeout_task, silence_task, farewell_task],
        return_when=asyncio.FIRST_COMPLETED,
    )
    
    # If we got here via farewell_task completion, give Twilio's buffer time to flush
    if farewell_task in done:
        call_state.transition_to(CallState.CLOSING)
        await asyncio.sleep(GOODBYE_DRAIN_MS / 1000)
    
    # Cancel pending tasks
    for task in pending:
        task.cancel()
    
    # ... existing cleanup ...
```

---

## System Prompt Update

Replace the current ENDING THE CALL block with the two-turn version. SQL:

```sql
UPDATE shops
SET system_prompt = regexp_replace(
    system_prompt,
    'ENDING THE CALL.*$',
    E'ENDING THE CALL — TWO-STEP PROCESS\n\nWhen the caller has explicitly confirmed they have no further questions, you will end the call in TWO steps across two turns. Follow this exactly:\n\nSTEP 1 (this turn): Call the `end_call` function. Set caller_confirmed_done=true. Set reason to a brief explanation. DO NOT say anything in this turn — your entire response is the function call. No text, no farewell, just the function call.\n\nSTEP 2 (your very next turn): After end_call returns successfully, your next response must be EXACTLY this farewell, word for word: "Thank you for calling Riyaaz Music Shop. Have a wonderful day!" Nothing before it, nothing after it. Just the farewell.\n\nWhat counts as explicit confirmation:\n- "No, that''s everything, thanks"\n- "That''s all I needed"\n- "I''m all set, goodbye"\n- "Nothing else, thank you"\n\nDo NOT call end_call in these situations:\n- The caller just finished giving you booking details — they may have more questions\n- The caller said "thanks" mid-conversation (politeness, not ending)\n- You just asked "anything else?" and have not yet heard their answer\n- The caller is still talking or providing information\n- You are still gathering booking details\n\nIf uncertain whether the caller is done, ASK: "Is there anything else I can help with?" Do not guess. Wait for their answer before deciding to call end_call.',
    's'
)
WHERE slug = 'riyaaz';
```

### Verification query

```sql
SELECT
    system_prompt LIKE '%TWO-STEP PROCESS%' AS has_two_step,
    system_prompt LIKE '%STEP 1 (this turn)%' AS has_step_1,
    system_prompt LIKE '%STEP 2 (your very next turn)%' AS has_step_2,
    system_prompt LIKE '%Thank you for calling Riyaaz Music Shop%' AS has_exact_farewell,
    length(system_prompt) AS prompt_length
FROM shops WHERE slug = 'riyaaz';
```

Expected:
- All four boolean columns: **true**
- prompt_length: ~5500-5800 chars

---

## Tests

The existing 9 pytest tests should still pass. Run `pytest -v` after implementation. If any fail, the most likely cause is signature changes to internal functions — add the missing parameters or add defaults to keep existing tests valid.

---

## Claude Code Prompt

Open Claude Code in the repo and paste exactly this:

```
Implement Phase 2.5: end-of-call architecture refactor (Approach E).

Read docs/phase_2_5_end_of_call_architecture.md fully before starting.

Goal: Replace the current system-baked farewell flow with a two-turn close pattern using a state machine in the bridge.

Implementation steps in order:

1. In app/bridge.py, add a CallState enum with three values: ACTIVE_CONVERSATION, AWAITING_FAREWELL, CLOSING.

2. Add a CallStateTracker class that wraps the state, holds the call_sid for logging, and exposes transition_to(new_state) which logs every transition with old->new state names. Add convenience methods is_active(), is_awaiting_farewell(), is_closing().

3. Update constants in app/bridge.py:
   - GOODBYE_DRAIN_MS: change from 4500 to 400
   - Add new constant FAREWELL_SAFETY_TIMEOUT = 8
   - Keep SILENCE_TIMEOUT at 30

4. Update _twilio_to_deepgram to accept call_state parameter. Hard-gate caller audio: if call_state.is_active() is false, skip forwarding media frames to Deepgram. Other event types (stop, etc.) handled normally.

5. Update _deepgram_to_twilio to accept call_state and agent_audio_done_event parameters:
   - On UserStartedSpeaking: only mark silence_tracker activity if call_state.is_active()
   - On FunctionCallRequest with end_call: validate caller_confirmed_done flag (existing behavior). If valid: send FunctionCallResponse with status "accepted, deliver farewell now", then call_state.transition_to(CallState.AWAITING_FAREWELL). Do NOT inject any goodbye message. Do NOT set any other event.
   - On AgentAudioDone event: if call_state.is_awaiting_farewell(), call agent_audio_done_event.set().
   - Other events: existing behavior.

6. Add a new async function _farewell_safety_watchdog(call_state, deepgram, shop, agent_audio_done_event):
   - Poll until call_state.is_awaiting_farewell() (or call_state.is_closing(), in which case exit early).
   - Once in AWAITING_FAREWELL, await agent_audio_done_event with a timeout of FAREWELL_SAFETY_TIMEOUT seconds.
   - If timeout fires (LLM did not deliver farewell): log a warning, call deepgram.inject_goodbye(shop.farewell) as fallback, then await agent_audio_done_event again with same timeout.
   - On any successful agent_audio_done_event: log success and return.

7. Update _silence_watchdog to accept call_state and shop:
   - Only loop while call_state.is_active().
   - When silence threshold reached: call_state.transition_to(CallState.AWAITING_FAREWELL), then deepgram.inject_goodbye(shop.farewell), then return. The farewell safety watchdog will handle disconnect from there.

8. Refactor run_bridge:
   - Create call_state and agent_audio_done_event at the top.
   - Pass call_state to _twilio_to_deepgram, _deepgram_to_twilio, _silence_watchdog, _call_timeout (where applicable).
   - Pass agent_audio_done_event to _deepgram_to_twilio and _farewell_safety_watchdog.
   - Pass shop to _silence_watchdog and _farewell_safety_watchdog.
   - Add farewell_task to the asyncio.wait.
   - Remove the old end_call_event-based flow.
   - When farewell_task is in done: call_state.transition_to(CallState.CLOSING), then sleep GOODBYE_DRAIN_MS/1000.
   - Cancel pending tasks and clean up as before.

9. Update _call_timeout to accept call_state and use it for transitions if needed.

10. Run pytest -v and confirm all existing tests still pass. If signature changes break tests, add default values for new parameters where reasonable, but do NOT modify test logic.

Do NOT:
- Update the system prompt in Supabase (I will do that manually).
- Commit or push.
- Add new pytest tests for the state machine (eval-style testing comes in Phase 4).

Report files modified, any concerns, and the pytest output.
```

---

## Manual Steps After Claude Code Finishes

### 1. Update system prompt in Supabase

Run the UPDATE query (above) in SQL Editor. Run the verification query. Confirm all four booleans are true and prompt_length is in the expected range.

### 2. Push to Railway

```bash
pytest -v       # confirm tests pass one more time
git add -A
git commit -m "Phase 2.5: end-of-call architecture (Approach E) — two-turn close with state machine"
git push
```

### 3. Wait for Railway ACTIVE

---

## Test Plan — 10 Focused Calls

**Each call should be logged with timestamp and SID for cross-referencing Railway logs.**

### Group A: Happy path (calls 1-4)

**Call 1 — clean simple ending:**
- Greeting → "I want to book a tabla lesson" → walk through booking → agent asks "anything else?" → "No, that's everything, thanks"
- **Expect:** end_call accepted, transition to AWAITING_FAREWELL, LLM speaks "Thank you for calling Riyaaz Music Shop. Have a wonderful day!", AgentAudioDone fires, call ends within ~500ms of farewell ending.
- **Logs to verify:** `State transition: active_conversation -> awaiting_farewell`, `end_call accepted`, `Farewell completed via LLM`, `State transition: awaiting_farewell -> closing`.

**Call 2 — booking with phone number:**
- Same as call 1, but say your phone number naturally with pauses ("six five zero, two seven zero, eight eight zero nine"). After full booking, say "no that's all, thanks".
- **Expect:** call survives the phone-number pauses (no premature end_call), then ends cleanly per call 1.
- **Logs to verify:** no `end_call rejected: caller_confirmed_done=false` warnings during the number capture.

**Call 3 — emotional caller:**
- Book a lesson with a warm tone — "oh wow, this is going to be so exciting for my daughter."  When agent asks "anything else?", reply "no thank you so much, this is wonderful."
- **Expect:** clean ending. The exact templated farewell ("Thank you for calling Riyaaz Music Shop...") plays — not a custom warm response.
- **Logs to verify:** `Farewell completed via LLM`. (If LLM goes off-script and says something custom, log it as a deviation but the call still ends cleanly.)

**Call 4 — caller hangs up before farewell:**
- Book a lesson. When agent asks "anything else?", say "no" and immediately hang up your phone.
- **Expect:** Twilio detects hangup, _twilio_to_deepgram exits, run_bridge cleans up. No fallback or weird states.
- **Logs to verify:** `Twilio disconnected` and clean call_logger entry.

### Group B: Mid-conversation guardrails (calls 5-7)

**Call 5 — mid-conversation thanks:**
- Start booking. Mid-flow, say "okay thanks, what days does Happy have available?"
- **Expect:** call does NOT end. Conversation continues normally.
- **Logs to verify:** if Gemini misfires, you'll see `end_call rejected: caller_confirmed_done=false`. If Gemini is well-behaved, you won't see any FunctionCallRequest at all. Either is acceptable.

**Call 6 — premature explicit-sounding phrase:**
- Start the call by saying "Hi, just confirming you're there?" (something that sounds like a confirmation but isn't).
- **Expect:** call does NOT end.

**Call 7 — caller asks about availability then closes:**
- Call, ask "what days does Happy teach?", listen to answer, say "okay great, that's all for now, thanks."
- **Expect:** clean ending per Group A. This tests whether "that's all for now" is treated as confirmation.

### Group C: Edge cases (calls 8-10)

**Call 8 — silence timeout:**
- Call, hear greeting, stay silent. After ~30s.
- **Expect:** silence watchdog fires, transitions to AWAITING_FAREWELL, system-injects fallback farewell, AgentAudioDone fires, call ends.
- **Logs to verify:** `Silence timeout reached, ending call`, then transition logs, then `AgentAudioDone received in AWAITING_FAREWELL`, then closing.

**Call 9 — long booking (3+ minutes):**
- Engage in a deliberately long conversation. Ask about Sandip ji, then about repair, then about showroom. Take your time. End naturally with explicit confirmation.
- **Expect:** clean ending. Tests that nothing gets weird in long conversations.

**Call 10 — fallback path test (synthetic):**
- This one is harder to trigger naturally. Say "I'm done, thanks" but if Gemini happens to skip the farewell turn (which we hope is rare), the safety timer should fire at 8s and the system fallback farewell plays.
- **Expect:** clean ending either via LLM farewell (most likely) or via fallback (acceptable).
- **Logs to verify:** if `LLM farewell did not complete within 8s` warning appears, that's the safety net working as designed.

---

## Success Criteria

After 10 calls:

- **Clean closure rate:** at least 9/10 calls end cleanly (no broken hangups, no calls hanging open >15s past final speech)
- **Average time from final word to disconnect:** under 1 second
- **Safety net firings:** ideally 0/10, acceptable up to 1/10
- **State transitions logged:** every call shows clear state machine progression in Railway logs
- **No regressions:** group B calls don't trigger premature end_call

If you see <8/10 clean closures, that's a signal Approach E may need refinement (or a model swap). Otherwise, Phase 2.5 ships.

---

## What's Next After Phase 2.5

If success criteria met:
- **Phase 3:** Google Calendar read integration, caller phone capture via TwiML Parameter, latency tuning (endpointing thresholds for phone numbers), Twilio prod account upgrade.
- **Optional:** Claude Haiku A/B test (run the same 10 scenarios on Haiku, compare clean closure rates).

If success criteria not met:
- Investigate logs for failure pattern. Most likely culprits: LLM not delivering farewell turn (prompt issue or model issue), AgentAudioDone not firing reliably (Deepgram API issue), state transitions not happening (logic bug).
