# Goal Prompt: Conversation Quality for Non-Technical Users

## Objective (user-approved 2026-07-16)

A planned UI absorbs setup, config, credential entry, and visibility (CLI use
disappears). What remains is how the agent talks and behaves in chat. Make the
conversation feel like a competent colleague, never a developer tool.

## Stages

### Stage V1 — Agent voice (cheap: copy + routing, one stage)

- Agent-voiced failures: operational failure receipts (skill installs, jobs,
  syncs) never print system text to chat; the failure routes to the agent,
  which explains in plain words and states its recovery move. Raw reasons stay
  in logs/runtime events for the UI.
- Kill the developer trailer: the agent report style ("Completed:/Used:/
  Changed:/Delegated:/Needs attention:" blocks) becomes plain prose — lead
  with the outcome, detail on request. Seat: the operating guidance block in
  the prompt profile service.
- Trust-ramp moments: surface promotion as felt experience ("I've done this
  5 times without issues — want me to stop asking?"), occasional gentle
  memory acknowledgments ("I remembered you prefer X"). Rides existing
  promotion counters + memory recall; copy only.

### Stage V2 — Skill and credential flows in agent voice

- Agent-initiated skill discovery: user states a goal; the agent searches,
  proposes ("found a skill for that — install it?"), one-tap install. No
  installer command strings in chat ever.
- Credential asks become "this needs your <service> login — add it in the
  app" with a UI deep link; env-var names never appear in chat.

### Stage V3 — Natural-language control

- Map casual phrases to controls: "stop asking me so much" / "be extra
  careful with deletes" / "pause everything" / "undo that" → permission mode,
  denylist entries, job controls. Chat = casual control surface; UI = precise
  one; both drive the same settings through existing reviewed flows.

### Stage V4 — Long-task narration

- Calm progress cadence during long tool runs (installs, renders): one
  editing progress line ("installing… 2 of 3"), building on the existing
  progress-lifecycle machinery. No walls of output, no dead air.

## Constraints

- No security rail changes; V3 routes through existing reviewed settings
  flows with the same approver requirements.
- The UI replaces all CLI-visibility items — do not build chat equivalents
  of dashboards; link to the UI instead.
- MANDATORY Codex plan-validation pass before V1 (per AGENTS.md). Per-stage
  review-then-commit; ledger `conversation-quality-assumptions.md`.
- Sequenced after permission simplification (P1-P4); V1 may be pulled
  earlier if desired — it is copy-only.

## Acceptance

- A failing skill install produces only agent prose in chat (no "Failed: x —
  reason" lines); logs retain the full reason.
- No agent message contains the Completed/Used/Changed trailer, installer
  command strings, or env-var names.
- "stop asking me so much" measurably switches the conversation's permission
  posture and confirms in one plain sentence.
- Long-running commands show a single editing progress line.

## V3/V4 validation addendum (2026-07-19, adversarial Codex review of the uncommitted diff on `feature/conversation-quality`)

Confirmed: exact posture-success copy with distinct failure paths; `render_progress`
rides the EXISTING AgentTodoSink lifecycle (`cardKind: 'progress'`) with all four
providers editing one cached message id in place; pause/resume/undo use only
existing reviewed tools (no rollback machinery). Generic undo and V2 remain
deferred (V2 is Credential-Center-UI-gated).

Corrections that MUST land before #232 absorbs V3+V4 (fix round dispatched):

1. **Delete-caution honesty**: `permissions.yolo_mode.denylist` matches nothing
   when yolo mode is disabled (yolo-mode-policy.ts:68) and is GLOBAL when
   enabled. Guidance: check posture via `settings_desired_state` first; yolo on →
   add entry AND disclose global scope; auto/attended → deletes already prompt,
   reply so, change nothing.
2. **Resume disambiguation (High)**: bare "resume" = conversational continue
   only, never a scheduler mutation. Bulk job resume requires explicit phrasing,
   acts only on jobs paused in this conversation, else confirms scope first.
3. **Test gap**: add the conversation-install path test — posture change writes
   `installed_agents.<install>.permission_mode: auto` in the canonical revision
   (existing test covers only the agent-level fallback).
4. **Ledgered behavior change**: ALL successful `request_settings_update` calls
   now route through the new reply classifier (unified success copy, duplicate
   direct host send suppressed, test-asserted). Intended consolidation.
