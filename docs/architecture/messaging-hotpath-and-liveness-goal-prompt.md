# Goal: Messaging hot-path latency + ambient liveness + dead-plumbing cleanup

\*\*Status: SCOPED 2026-07-19 (two parallel audits: Codex latency/over-engineering

- Fable UX). Queue position: see goals-index.\*\* Via gantry-goal-pipeline with a
  Codex plan-validation pass before stage 1.

## Governing principle (LOCKED)

The conversation surface stays CLEAN. No status/duration text, no "Done in Xm",
no extra messages. Liveness is AMBIENT ONLY — reactions, typing indicators, and
replace-only edits of the ONE existing progress/todo card. Every UX item below
adds signal WITHOUT adding a message. (Memory: no-status-clutter-in-chat.)

## Why

Two audits of the messaging path (main @6a817b43f) agree: time-to-first-reply is
dominated by redundant synchronous work, and the "still alive" signals are
mostly dead or unwired code. Fixing both is net DELETION plus faster replies.

## Part A — Latency (Codex-ranked; hot path = user message → first agent output)

1. **Conversation-history hydration blocks prompt build up to 2.5s.** A window is
   "complete" only after 30 stored messages, so sparse/new Slack/Discord/Teams
   conversations re-request provider history every turn, then persist row-by-row
   before re-querying (`runtime/conversation-context.ts:4-12,81-85`,
   `runtime/group-conversation-context.ts:34-56,142-199`,
   `app/bootstrap/channel-wiring-conversation-context.ts:19-35`). Fix: explicit
   hydration watermark/completeness state (not row-count); move history
   persistence off the first-visible critical path. **Biggest single win.**
2. **~24-25 sequential SQL statements per inbound message before admission wake.**
   Metadata `ensureConversation` (~9 stmts) then message txn (~9 same conversation
   stmts + participants + upserts, ~15) — the canonical "ensure everything" graph
   is re-upserting stable app/profile/provider/agent/account identities on EVERY
   message (`repositories/canonical-graph-repository.postgres.ts:106-163,204-277`,
   `repositories/canonical-message-repository.postgres.ts:240-373`). Fix: use the
   already-established canonical FKs; drop ~20-22 redundant upserts. Carry
   name/kind metadata IN the ingress op so the separate awaited metadata write +
   its 34-line queue handler die (`channel-persistence-handlers.ts:29-54,221-260`,
   4 provider blocks ~37 LOC).
3. **Double message-fetch:** admission fetches pending messages, then the group
   processor fetches the same window again (`runtime/message-loop.ts:505-519`,
   `runtime/group-processing.ts:94-108`) — pass the validated batch through (~14
   LOC deleted).
4. **Double context hydration:** admission `getAgentTurnContext(hydrateMemory:
false)` then runner calls it again with memory (`live-execution.ts:224-244`,
   `group-agent-runner.ts:149-175`) — reuse the lease's canonical agentSessionId.
5. **Gateway holds streamed first-bytes for a success-audit await** before setting
   response headers (`gantry-model-gateway.ts:489-518`,
   `gantry-model-gateway-http.ts:20-35`) — make the audit fire-and-forget for
   streaming. (Cross-check with the separate deepagents/SDK audit before editing
   the gateway — that audit owns the model-client hot path.)
6. Worker cold-start (workspace/sandbox/MCP/egress) on every default turn is real
   but is the FAST-PATH question, deferred to model-management's inline-lane
   discussion, NOT this cycle — noted, not fixed here.

## Part B — Ambient liveness (Fable-ranked, no-clutter-filtered)

1. **Revive the progress heartbeat as a REPLACE-ONLY card edit.**
   `startGroupProgressHeartbeats` already receives getElapsedMs/
   getLastAgentProgressAt/hasVisibleOutput and ignores all three; progressTimer is
   hardcoded null (`runtime/group-progress-heartbeats.ts:114-169`, values piped at
   `group-processing.ts:492-494`). Wire it: if no agent progress for N minutes,
   edit the existing card via `sendProgressToChannel(replaceOnly:true)` with a
   PLAIN "Still working" (NO elapsed text — clutter rule). This also fixes
   stuck-vs-working: stop refreshing Telegram typing when the runner is actually
   stalled so typing stops lying.
2. **Typing/ack parity for Discord + Teams.** Implement TypingSink on both (single
   API call each); the 4s refresh loop is already provider-agnostic. Wire Teams'
   reaction (its addReaction is a no-op, `channels/teams.ts:247`).
3. **Seen→running reaction FLIP on slow spawns.** Both Telegram and Slack already
   MAP a 'running' hourglass reaction that NO caller ever sends
   (`telegram/reactions.ts:5`, `slack/reactions.ts:6`); flip seen→running after
   ~5s without first output, clear on first output. Pure ambient.
4. **Ack mid-run pokes with the seen reaction.** A continuation piped into an
   active run currently gets no receipt on Slack/Discord/Teams
   (`runtime/message-loop.ts:459-476`) — add the existing reaction ack.
5. **Deferral receipt as a reaction (NOT text).** Messages rejected as
   continuations silently wait for the run to end (`runtime/group-queue.ts:427-438`)
   — give them at least the seen reaction so they don't look lost.
6. **Retry visibility by EDITING the existing failure card.** Silent cursor-
   rollback retry shows "I hit an issue." then an unexplained fresh turn
   (`group-processing-flow.ts:34-40`, backoff `group-queue.ts:601-610`); thread the
   existing `finalRetry` count into the SAME card ("retrying 2/3" / "gave up") —
   edit, never new messages.

## Part C — Dead-plumbing deletion (from the Done-in removal + audits)

- `elapsed` param `sendFinalProgressUpdate` receives and drops
  (`runtime/progress-updates.ts:20-38`) + the `formatElapsed(activeElapsedMs())`
  feeding it (`group-processing.ts:413`).
- Slack `/^Done in\b/` matcher (`channels/slack/thread-progress-status.ts:20`).
- Unused `elapsed` in todo-card header renderer (`channels/agent-todo-render.ts:
68-69`) — DELETE, do not populate (clutter rule).
- Dead signature/state in group-progress-heartbeats.ts once Part B rewires it
  (~20-30 LOC of ignored inputs).
- Slack fake-typing no-op + its capability lie (`slack/channel-delivery.ts:669`,
  `channel-capability-ports.ts:14-17`) — either implement real Slack typing or
  drop the method so the capability sniff stops dispatching useless refreshes.
- 31-line single-caller `ipc-message-delivery.ts` wrapper (delegates to
  sendCoreMessage) — inline + move its test to the core-tool seam.

## Non-goals

- No duration/status text anywhere (governing principle).
- No fast-path/inline-lane triage (model-management cycle owns that).
- Do NOT touch the durable admission queue, group concurrency queue, streaming
  sanitizer, edit-in-place card maps, or per-provider edit throttles (Slack 550 /
  Telegram 950 / Discord 1200 / Teams 1800 ms) — audit cleared them as protecting
  lease ownership, bounded concurrency, safe text extraction, and provider
  rate-limits.
- Model-client hot path (SDK/deepagents TTFT, prompt caching) is a SEPARATE audit
  - cycle; §A5 gateway change coordinates with it.

## Stages (each leaves the tree green)

1. Part C deletions (pure removal, no behavior change) + Slack typing decision.
2. Part B ambient liveness (heartbeat revive, typing/ack parity, reaction flips,
   retry-card) — invariant: zero new messages posted; all signals are
   reaction/typing/replace-only edits.
3. Part A latency: hydration watermark + off-path persistence (A1), then the
   redundant-upsert/double-fetch/double-hydration collapse (A2-A4), then the
   gateway streaming-audit (A5, coordinated with the model-client audit).

## Verification

Per stage: typecheck + full unit + throwaway-DB integration for the persistence
changes; a hot-path statement-count assertion (A2/A3 must measurably reduce SQL
round-trips); manual 4-provider smoke that liveness signals appear and NO extra
messages are posted. Existing suites green.
