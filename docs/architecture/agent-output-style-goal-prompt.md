# Agent output style + model identity — goal prompt

Status: SCOPED 2026-07-20 night. User directive: agent output must stop
narrating execution, drop AI-slop patterns (no dash-as-punctuation anywhere),
be concise/conversational/structured (ADHD-skill-shaped), and the system
prompt must know the model. Grill decisions DEFAULTED to recommendations under
night authority (user asleep) — overturn any in the morning.

## Decisions (defaulted; flag = revisit)

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

Injected at compile (both lanes), stable facts only:
1. **Model identity**: alias + concrete model id + provider (decision 3).
2. **Time**: turn-start timestamp + the conversation's IANA timezone, with the
   rule "as of turn start; use the date tool when precision matters".
3. **Channel context**: channel kind, DM vs group, formatting dialect
   (Telegram HTML subset / Slack mrkdwn / plain), message-length limit,
   attachment ceiling (25MB workspace-direct).
4. **Interlocutor + approver**: speaker display name/handle; who approves
   permissions in this conversation.
5. **Workspace geography**: workspace path; durable outputs in `media/`;
   tmp is ephemeral.
6. **Job context** (job runs only): job name/id, quiet-until-terminal.
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

## Non-goals

- No output post-processing/rewriting layer.
- No per-channel style forks (one block, channel-agnostic).
- No persona changes (SOUL.md untouched — this is mechanics, not personality).
