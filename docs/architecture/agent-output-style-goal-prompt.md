# Agent output style + model identity — goal prompt

Status: GRILL-LOCKED 2026-07-20 night (user confirmed all four decisions).
AUDIT COMPLETE — key findings the implementation MUST address:
- **CRITICAL truncation bug:** full OPERATING_GUIDANCE_BLOCK is 9,755 chars vs
  the 8,500 budget (`DEFAULT_PROMPT_SECTION_BUDGETS.OPERATING_GUIDANCE`,
  prompt-profile-service.ts:41) — the compiler slices mid-word and the entire
  `## Communication` section (the existing anti-slop guidance) NEVER reaches
  full-preset agents. Raise the budget to ~12000 AND add a budget-guard test
  (raw content length ≤ budget) so growth can't silently re-truncate.
- **Insertion points:** Output Style block → appended to
  `OPERATING_GUIDANCE_COMMUNICATION` (:216-225; both full+locked variants
  spread it). Model line → appended to runtime-rules content in
  `compileSystemPrompt` (:391-398), both variants (budget 1200, ~450 used).
- **Model plumbing (4 files):** `modelIdentity {alias, modelId, provider}` on
  `CompilePromptProfileOptions` (:244); thread through
  agent-spawn-prompt.ts:11-36; call sites agent-spawn.ts:224 and
  agent-spawn-host.ts:164-175 from `resolvedModel.value.modelEntry`
  (displayName / runnerModel / modelRoute.label). Cache split unaffected.
- **Contradiction fix:** remove "with receipts" phrasing from Execution Bias
  (gantry-agent-system-prompt.ts:165); "never append a labeled receipt block"
  wins (user decision 4). Results speak for themselves.
- **Ack carve-out:** the SINGLE short acknowledgement before non-trivial live
  work stays (5 existing mandate sites); the no-narration rule explicitly
  excepts it.
- Exact proposed Output Style text + model-line text + unit-test plan (5
  suites incl. minimal/none prompt-mode survival) are in the audit report —
  follow them.

## Decisions (user-confirmed 2026-07-20 night)

1. **No execution commentary.** The agent never narrates tool use or process
   ("Let me run...", "Now I'll check...", step-by-step commentary). It speaks
   outcomes, answers, and necessary questions. Progress belongs to ambient
   liveness (typing/reactions/edit-in-place), per the no-status-clutter rule.
2. **Output style block (ADHD-shaped, model-agnostic):** lead with the
   answer/outcome; short sentences; multi-item answers as numbered/bulleted
   structure; no preambles ("Great question", "Sure!"), no closers ("Let me
   know if..."), no filler; NO dash-as-punctuation (no " - " or em/en dashes
   as clause separators; hyphens only inside compound words); match the
   user's language; concise by default, complete when the user asks for depth.
3. **Model identity injected.** The compiled system prompt states the resolved
   model: alias + concrete model id + provider (model resolution completes
   before prompt compile in both lanes; audit confirms exact plumbing).
4. **Scope + enforcement:** all agents, all channels, both lanes (worker +
   inline), locked-variant kept consistent. PROMPT-LEVEL ONLY — no
   post-processor rewriting agent text. Tests: unit (block + model line
   present in compiled prompt, both lanes, locked variant intact) + a matrix
   e2e row later (behavioral: reply to a directive prompt contains no
   narration markers; heuristic, non-blocking initially).

## Context the prompt must carry (user-directed, 2026-07-20 night)

Injected at compile (both lanes), stable facts only — ALL 7 adopted (user):
1. **Model identity**: alias + concrete model id + provider (decision 3).
2. **Time + timezone**: turn-start timestamp + the conversation's IANA tz
   (TZ already reaches the runner env, never the prompt); FIX minimal prompt
   mode omitting the date section entirely (gantry-agent-system-prompt.ts:
   100-109). Rule: "as of turn start; use the date tool when precision
   matters".
3. **Channel context + length ceiling**: channel kind, DM vs group, formatting
   dialect (Telegram HTML subset / Slack mrkdwn / plain), per-channel message
   length cap (e.g. Telegram 4096), attachment ceiling (25MB
   workspace-direct).
4. **Interlocutor + approver**: speaker display name/handle; who approves
   permissions in this conversation.
5. **Interruptibility contract**: one line stating new user messages may
   arrive MID-RUN and supersede the current plan (IPC drain,
   runner/index.ts:154-159) — drained messages are instructions, not history.
6. **Workspace geography**: workspace path; durable outputs in `media/`;
   tmp is ephemeral.
7. **Job context** (job runs only): job name/id, quiet-until-terminal.
NOT here (owned elsewhere): environment facts/sandbox (media Stage 5 env-facts
block), persona (SOUL.md), same-turn capability honesty (acquisition lane).
Skipped as YAGNI: runtime version, locale beyond language-matching, rate
limits.

## Implementation

Waits for the prompt-audit report (in flight): exact insertion points in
prompt-profile-service.ts (OPERATING_GUIDANCE_BLOCK + locked variant),
compileSpawnSystemPrompt plumbing for the model identity in both call sites,
plus the audit's "what else is the prompt missing" list (max 5, adjudicated
before adoption). Implementer: Fable subagent. Verification: typecheck + full
unit + prompt-snapshot unit tests. Rides the normal merge-on-green policy.

## Cache-safety constraint (user, 2026-07-20 night — HARD)

The runner splits the system prompt static/dynamic at
SYSTEM_PROMPT_DYNAMIC_BOUNDARY for Anthropic prompt-cache parity (#236).
Nothing per-turn-varying may enter the static side: time/timezone rides ONLY
the existing dynamic date section (minimal mode gains that DYNAMIC section,
never a static timestamp); the model line changes only with config;
channel/speaker/workspace/job facts must be session-stable or move to the
dynamic tail. REQUIRED test: two builds of the same session at different clock
times produce a byte-identical static prefix.

## Non-goals

- No output post-processing/rewriting layer.
- No per-channel style forks (one block, channel-agnostic).
- No persona changes (SOUL.md untouched — this is mechanics, not personality).
