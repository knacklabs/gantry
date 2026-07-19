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

## Part D — Model-client hot path (deepagents + Anthropic SDK audit 2026-07-19)

The SAME #1 barrier as A5, confirmed by a second independent audit: the gateway
awaits the durable usage-audit before piping the first streamed byte, on EVERY
model call in BOTH engines. Plus:

- **[quick win]** inline DeepAgents passes NEITHER `prompt_cache_key` NOR
  cache-mode (spawned does) — `inline-lane/index.ts:371`; add parity (latency+cost).
- **[quick win]** SDK awaits `getContextUsage()` before result-only fallback +
  before releasing buffered follow-ups (`query-loop.ts:623`) — move to a later
  telemetry frame (normal deltas already streamed).
- **[quick win]** inline DeepAgents connects remote MCP servers serially
  (`inline-lane/index.ts:472`) — connect concurrently, deterministic order.
- **[CYCLE, separate]** spawned DeepAgents rebuilds model+MCP-subprocess+tools+
  graph every follow-up (`runner/index.ts:215`); credential re-decrypt every
  gateway call (`gantry-model-gateway.ts:373`); SDK rebuilds prompt/tools/MCP/
  sandbox each new Query. → "agent-engine warm-reuse" follow-on cycle (revision/
  content-hash-keyed reusable projections + long-lived worker/client reuse).
- Prompt caching on the SDK system prompt IS correctly wired (static/dynamic
  boundary) — good, don't touch. No hidden extra model round-trips in either
  engine — not over-engineered there.

## Stages (RESTAGED per plan-validation — NOT approved as written; see below)

**Stage 1 — SAFE deletions + no-duration contract (pure/low-risk; overnight-OK).**
Part C removals that are genuinely dead: final-progress `elapsed` param
(`progress-updates.ts:20-37`), Slack `/^Done in\b/` matcher, 31-line
single-caller `ipc-message-delivery.ts` wrapper, Slack no-op `setTyping` +
its capability-lie (drop the method so the sniff stops dispatching useless
refreshes), dead unused params in `group-progress-heartbeats.ts`. PLUS the
todo-card `elapsed` field removal as an INTENTIONAL no-duration contract change
(validation: it is NOT dead — it renders — so remove it across producers/tests
as a deliberate no-clutter contract, per [[no-status-clutter-in-chat]]).

**Stage 2 — approved latency wins with exact recipes (low blast radius).**

- A5/D gateway audit: start the audit promise, set headers + pipe IMMEDIATELY,
  then await audit AND pipe-completion together with the existing fail-open catch
  — concurrent-but-awaited, NOT fire-and-forget (detached loses the durable
  credential audit on shutdown). Gateway OTel stays the all-lanes attach point.
- Part D quick wins: inline DeepAgents `prompt_cache_key`/cache-mode parity;
  move SDK `getContextUsage()` off the result-only critical path; concurrent
  inline remote-MCP connect.

**Stage 3 — DEFERRED, needs user-supervised design (do NOT auto-implement).**
Each requires a contract the validation says is missing:

- A1 hydration: explicit conversation/thread history-state column (account +
  hydrated-through cursor; not a bool, not `updated_at`); in-memory merge for the
  current turn + separate durable persistence; watermark marked complete ONLY
  after every accepted write commits (crash before → incomplete).
- A2 upserts: delete ONLY the ~8 same-transaction nested-thread identity/config
  repeats (after pinning nested-conversation recency timestamp) + the
  startup-proven app/profile writes. Provider/agent/account collapse needs a
  commit-backed graph-ready receipt carried from ingress/setup. NO compensating
  SELECTs (that trades one round trip for another). Conversation/participant/
  message/part/admission writes are LOAD-BEARING.
- A3 double-fetch: SPLIT OUT unless the cursor-fence contract is designed+tested
  — replay carries fields a bare array loses and the cursor advances between
  admission and execution; reuse is safe only with a full-replay+`cursorBefore`
  payload proven unchanged, else keep the authoritative second fetch.
- A4 hydration: KEEP the admission-side scope-resolving call; fix the runner's
  DOUBLE memory hydration — carry admission session identity as a fenced expected
  id, `hydrateMemory:false` on pre-promotion reads, hydrate memory exactly ONCE
  against the final promoted context.
- Part B heartbeat revive + typing/ack parity + reaction flips + retry-card:
  the zero-new-message invariant is UNVERIFIED — the heartbeat and the agent
  progress card do NOT currently share one message handle, so a naive revive
  could post a second card. Confirm card-handle sharing (cardKind separation)
  FIRST, then implement as replace-only edits.

## Verification

Per stage: typecheck + full unit + throwaway-DB integration for any persistence
change; Stage 2 gateway change needs a byte-identical-stream test + a first-byte-
before-audit-settles assertion; Stage 3 (when done) needs a hot-path statement-
count assertion and a 4-provider smoke proving NO extra messages are posted.
Existing suites stay green. See the full evidence in the plan-validation section.

## Plan-validation (2026-07-19)

**Overall verdict: NOT APPROVED AS WRITTEN.** The measured seams are real, but
A2, A3, A5, and the Part B card-ownership claim need the corrections below
before implementation. A1 and A4 remain valid optimization targets after their
reader/scope contracts are made explicit. The plan also needs the required
Surface Impact Matrix before approval (`AGENTS.md:203-204`); a validated matrix
is supplied at the end of this section.

### 1. A2 redundant upserts — UNSAFE AS WRITTEN

The quoted count is only the no-thread, one-route shape: one metadata
`ensureConversation` is nine writes, and the message transaction is another
nine graph writes plus three participant writes, message, message part, and
live-admission enqueue (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:106-162,204-276`,
`apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts:261-373,429-467`).
A thread adds a second complete nine-write `ensureConversation` plus the thread
insert (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:280-311`),
and multiple bound routes repeat the whole message transaction once per route
(`apps/core/src/app/bootstrap/channel-persistence-handlers.ts:172-196`). Thus
"~24-25" is not a stable path count and "drop ~20-22" is not supported.

Classification below is for the current inbound hot path. `SKIPPABLE` means a
cheap existing proof is identified; `CONDITIONAL` means the write creates first
contact/setup state and may be skipped only with the stated proof; and
`LOAD-BEARING` means the current contract must retain it. A deterministic ID is
not proof that its row exists. In particular, `conversations.provider_account_id`
has only an index, not an FK (`apps/core/src/adapters/storage/postgres/schema/conversations.ts:11-35`),
while the message row has actual account/conversation/thread FKs
(`apps/core/src/adapters/storage/postgres/schema/messages.ts:20-39`).

| Upsert/write on the inbound path                                           | Verdict                                         | Current responsibility and required guard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps` in outer `ensureConversation` (metadata and message passes)         | **SKIPPABLE**                                   | Runtime startup already asserts the canonical app exists; guard on successful storage readiness, not a per-message lookup (`apps/core/src/adapters/storage/postgres/storage-service.ts:186-230`).                                                                                                                                                                                                                                                                                                                                                                                               |
| `llm_profiles` in outer `ensureConversation` (metadata and message passes) | **SKIPPABLE**                                   | The same readiness assertion proves the default profile, and this row is not a message FK (`apps/core/src/adapters/storage/postgres/storage-service.ts:194-225`, `apps/core/src/adapters/storage/postgres/schema/messages.ts:20-39`).                                                                                                                                                                                                                                                                                                                                                           |
| `providers` in `ensureConversation` (metadata and message passes)          | **CONDITIONAL**                                 | It creates the provider needed by a fallback account; skip only when ingress carries a trusted persisted provider-account receipt, whose provider FK proves this row (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:217-239`, `apps/core/src/adapters/storage/postgres/schema/providers.ts:27-40`).                                                                                                                                                                                                                                              |
| inner `apps` in `ensureAgent` (metadata and message passes)                | **SKIPPABLE**                                   | Same startup-readiness guard as the outer app write; the nested repeat is visible at `ensureAgent` entry (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:127-135`).                                                                                                                                                                                                                                                                                                                                                                               |
| inner `llm_profiles` in `ensureAgent` (metadata and message passes)        | **SKIPPABLE**                                   | Same startup-readiness guard; `ensureAgent` invokes both seed writes again through `ensureApp` (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:106-124,127-135`).                                                                                                                                                                                                                                                                                                                                                                                 |
| `agents` in `ensureAgent` (metadata and message passes)                    | **CONDITIONAL**                                 | It is the only creation of the derived provider agent in the fallback graph and also rewrites its name/config pointer; skip only for an explicit persisted account route or a graph-ready receipt for the fallback account (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:135-151,240-255`).                                                                                                                                                                                                                                                     |
| `agent_config_versions` in `ensureAgent` (metadata and message passes)     | **CONDITIONAL**                                 | It creates config for that fallback derived agent. It is not required by the message FKs, but removing it alone leaves the agent graph incomplete; guard with the same graph-ready receipt or move fallback graph creation to setup (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:135-162`, `apps/core/src/adapters/storage/postgres/schema/agents.ts:28-80`).                                                                                                                                                                                  |
| `provider_accounts` in `ensureConversation` (metadata and message passes)  | **CONDITIONAL**                                 | This is load-bearing first-contact creation for the fallback ID, and messages FK to it. Skip only when a trusted persisted route/account receipt is carried into the transaction; computing the ID is insufficient (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:219-255`, `apps/core/src/adapters/storage/postgres/schema/messages.ts:27-35`). Settings-side account persistence is a separate authoritative creator for configured accounts (`apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts:458-499`). |
| `conversations` in the metadata pass                                       | **LOAD-BEARING**                                | It creates first contact and updates title, kind, external reference, and monotonic recency; chat listing reads and orders that recency (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:256-276,401-425`).                                                                                                                                                                                                                                                                                                                                        |
| `conversations` in the message pass                                        | **CONDITIONAL**                                 | It remains first-contact/recency authority when no fused metadata write ran. It is skippable only if a fused ingress transaction returns the exact canonical conversation receipt after applying metadata at an equal-or-newer timestamp (`apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts:261-269`, `apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:268-275`).                                                                                                                                      |
| nested thread `apps` (outer)                                               | **SKIPPABLE**                                   | The immediately preceding top-level `ensureConversation` completed in the same transaction; pass its returned `conversationId` into a thread-only insert (`apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts:261-275`, `apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:292-311`).                                                                                                                                                                                                                      |
| nested thread `llm_profiles` (outer)                                       | **SKIPPABLE**                                   | Same-transaction proof from the preceding conversation graph, in addition to startup readiness (`apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts:261-275`, `apps/core/src/adapters/storage/postgres/storage-service.ts:194-225`).                                                                                                                                                                                                                                                                                                                 |
| nested thread `providers`                                                  | **SKIPPABLE**                                   | The preceding conversation graph inserted/proved the same provider in this transaction (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:217-239,292-311`).                                                                                                                                                                                                                                                                                                                                                                                         |
| nested thread `apps` (inner `ensureAgent`)                                 | **SKIPPABLE**                                   | The preceding graph and the nested thread's own outer `ensureApp` both already prove it; this is a second nested repeat (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:127-135,216-244,292-311`).                                                                                                                                                                                                                                                                                                                                                |
| nested thread `llm_profiles` (inner `ensureAgent`)                         | **SKIPPABLE**                                   | The preceding graph and startup readiness prove it before the thread insert (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:106-124,127-135,292-311`).                                                                                                                                                                                                                                                                                                                                                                                            |
| nested thread `agents`                                                     | **SKIPPABLE**                                   | The preceding conversation graph ensured the identical derived agent in the same transaction (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:240-255,292-311`).                                                                                                                                                                                                                                                                                                                                                                                   |
| nested thread `agent_config_versions`                                      | **SKIPPABLE**                                   | The preceding conversation graph ensured the identical config in the same transaction (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:152-162,240-255,292-311`).                                                                                                                                                                                                                                                                                                                                                                                  |
| nested thread `provider_accounts`                                          | **SKIPPABLE**                                   | The preceding conversation graph ensured the identical account in the same transaction (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:245-255,292-311`).                                                                                                                                                                                                                                                                                                                                                                                         |
| nested thread `conversations`                                              | **CONDITIONAL**                                 | Pass the `conversationId` returned immediately before `ensureThread`, but first lock the recency contract: the outer call uses the message timestamp while the nested call omits it and therefore uses `currentIso()`, which can advance `updated_at` (`apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts:261-275`, `apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:223-224,268-275,292-296`). Skip only after tests establish which timestamp chat recency must use.                                  |
| `conversation_threads`                                                     | **CONDITIONAL**                                 | It is the only first-contact creator for a new thread, and `messages.thread_id` FKs to it. Keep unless a trusted thread receipt/cache entry is scoped by account + conversation + external thread and is populated only after commit (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:280-311`, `apps/core/src/adapters/storage/postgres/schema/messages.ts:33-39`).                                                                                                                                                                               |
| `users`                                                                    | **LOAD-BEARING**                                | Current ingress both creates a first-seen user and refreshes mutable display name/time; there is no authoritative presence/metadata receipt on `NewMessage` (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:315-354`).                                                                                                                                                                                                                                                                                                                            |
| `user_aliases`                                                             | **LOAD-BEARING**                                | It creates the provider-account-scoped alias and refreshes its user/name mapping; its unique identity includes app/provider/account/external user (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:355-375`, `apps/core/src/adapters/storage/postgres/schema/apps.ts:41-69`).                                                                                                                                                                                                                                                                      |
| `conversation_participants`                                                | **LOAD-BEARING**                                | It is the only first-contact membership creation here and reactivates status; downstream FK integrity alone cannot replace that membership behavior (`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:376-397`, `apps/core/src/adapters/storage/postgres/schema/conversations.ts:64-92`).                                                                                                                                                                                                                                                           |
| `messages`                                                                 | **LOAD-BEARING**                                | This is the durable inbound fact and redelivery/update seam (`apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts:321-355`).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `message_parts`                                                            | **LOAD-BEARING**                                | This stores/updates the text payload consumed by message readers (`apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts:356-373`, `apps/core/src/adapters/storage/postgres/schema/messages.ts:85-101`).                                                                                                                                                                                                                                                                                                                                                |
| optional attachment replace (select/delete/insert; not an upsert)          | **LOAD-BEARING when `attachments` is supplied** | It preserves storage refs and makes the supplied attachment set authoritative; statement counts therefore also vary with payload (`apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts:374-426`).                                                                                                                                                                                                                                                                                                                                                     |
| `live_admission_work_items` enqueue                                        | **LOAD-BEARING for eligible inbound messages**  | Message persistence and admission enqueue are atomic; the conflict path deliberately replays the durable item (`apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts:429-467`, `apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts:51-117`).                                                                                                                                                                                                                                                         |

**A2 correction:** retain the fused metadata + message transaction idea, delete
the eight same-transaction nested thread identity/config repeats after pinning
the nested conversation recency behavior, and remove only the startup-proven
app/profile writes initially. Defer the provider/agent/account collapse until
ingress/setup supplies a commit-backed graph-ready receipt;
do not add compensating SELECTs, because that substitutes one round trip for
another. Conversation, participant, message, part, and admission writes remain.

### 2. A1 hydration watermark — VALID PROBLEM, INCOMPLETE FIX

For top-level context, the code indeed equates completeness with 30 rows; for a
thread it requires 50 rows **and** the root, so the original blanket “complete
only after 30” wording is stale (`apps/core/src/runtime/conversation-context.ts:4-12,76-85`,
`apps/core/src/runtime/group-conversation-context.ts:189-199`). Unsupported
channels return a skipped hydration result, rather than fetching provider
history, although the wrapper is still entered on each incomplete turn
(`apps/core/src/app/bootstrap/channel-wiring-conversation-context.ts:19-35`).

Moving persistence off-path without another change is incorrect: after
hydration the code persists each accepted row, re-queries Postgres, and builds
both the prompt and memory-recall query from that re-query
(`apps/core/src/runtime/group-conversation-context.ts:57-122`). The safe shape is
to apply the existing filtering/deduplication rules to an in-memory merged
packet for the current turn, enqueue durable persistence separately, and mark
the hydration state complete only after every accepted write commits. A crash
before those writes complete must leave the watermark incomplete.

No existing field has the right meaning. Conversations/threads expose only
identity, status, and timestamps (`apps/core/src/adapters/storage/postgres/schema/conversations.ts:11-61`);
agent/provider session fields describe model-session lifecycle, not channel
history (`apps/core/src/adapters/storage/postgres/schema/sessions.ts:22-51,67-95`).
Use explicit conversation- and thread-scoped history state with a provider
account and hydrated-through cursor/time, not a bare boolean and not
`updated_at` (which message persistence advances for chat recency at
`apps/core/src/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.ts:268-275`).

### 3. A3 double fetch — OBSERVATION TRUE, REUSE CLAIM FALSE AS WRITTEN

Admission fetches from its recovered cursor and passes the complete replay
object (messages, `hasMore`, cursor, response schema, controls) into trigger and
active-run handling (`apps/core/src/runtime/message-loop.ts:327-395,479-522`).
The later group processor independently re-reads from the then-current cursor
(`apps/core/src/runtime/group-processing.ts:94-110`). These are not guaranteed
equivalent: pending replay paginates and truncates at control-bearing messages,
and its result includes fields that a bare message array loses
(`apps/core/src/runtime/pending-message-replay.ts:40-96`). Between admission and
queued execution, the cursor can advance and more messages can arrive; the
active-run branch itself advances the cursor after a successful pipe
(`apps/core/src/runtime/message-loop.ts:443-466`).

Therefore do not delete the second fetch merely by passing the first array.
Reuse is safe only with a queue payload containing the full replay plus
`cursorBefore`, and only after the group processor proves its current cursor is
unchanged; otherwise it must fetch the tail/current window. If the queue cannot
provide that fence cheaply, retain the authoritative second fetch. A3 should be
split from this cycle unless that cursor contract is designed and tested.

### 4. A4 context/memory hydration — PARTIAL; ADMISSION CALL MUST STAY

The admission-side `hydrateMemory:false` call is load-bearing: it resolves the
canonical app/session scope used to find or claim the live turn and supplies the
provider session recorded on the run (`apps/core/src/app/bootstrap/live-execution.ts:224-300`).
It cannot simply be dropped in favor of runner hydration. The repository call
also ensures the agent session, releases stale maintenance locks, optionally
promotes a ready provider session, and then selects the latest resumable
provider session (`apps/core/src/adapters/storage/postgres/repositories/canonical-session-repository.postgres.ts:58-104`).

The runner currently loads once before compaction handling, and the common
non-pending path loads again with promotion enabled
(`apps/core/src/runtime/group-agent-runner.ts:149-175`,
`apps/core/src/runtime/group-agent-runner-compaction-delta.ts:50-61`). Because
memory hydration is the default after every repository lookup, that can hydrate
memory twice in the runner, not merely once after admission
(`apps/core/src/adapters/storage/postgres/services/canonical-session-ops-service.ts:194-225`).
Correct A4 by carrying the admission session identity as an expected/fenced
identity, keeping the runner's final provider-session refresh, setting
`hydrateMemory:false` on pre-promotion/provisional reads, and hydrating memory
exactly once against the final promoted context.

### 5. A5 gateway audit — LATENCY CLAIM TRUE; FIRE-AND-FORGET REJECTED

For streaming responses, payload parsing returns immediately without usage,
then the gateway awaits `credential.model.used` audit before setting headers and
piping bytes (`apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway-http.ts:20-35`,
`apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts:489-519`).
That await can delay first byte. However, detached fire-and-forget can lose the
durable audit during shutdown; the audit is the credential-use record and is
explicitly awaited by its helper (`apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts:529-580`).

The OTel stream path is independent: it taps chunks and finalizes usage after
the pipe (`apps/core/src/adapters/llm/observability/genai-spans.ts:350-430,434-497`).
Billing queries accept `credential.model.used` only when numeric token usage and
an API-key scope are present (`apps/core/src/adapters/storage/postgres/repositories/runtime-event-repository.postgres.ts:283-301`),
while the streaming pre-pipe audit has no parsed usage. Runner output separately
publishes normalized `model.usage` when provider usage is present
(`apps/core/src/runtime/group-agent-runner.ts:273-347`). Thus this audit is not
the streaming OTel/usage source today, but it is still durable credential audit.

Correct implementation: start the audit promise, set headers and begin piping
immediately, then await audit and pipe completion together (with the existing
fail-open catch). This removes TTFT coupling without abandoning durability.
Keep the stated coordination with the separate DeepAgents/SDK model-client
audit; gateway OTel remains the all-lanes attach point
(`docs/architecture/otel-llm-observability-goal-prompt.md:11-16,21-26`).

### 6. Part B liveness — DEAD PLUMBING CONFIRMED; CARD SAFETY NOT CONFIRMED

- `progressTimer` is hardcoded `null`; `hasVisibleOutput`,
  `getLastAgentProgressAt`, `getElapsedMs`, `buildProgressOptions`, and
  `sendProgressToChannel` are accepted but unused, while the caller supplies
  them (`apps/core/src/runtime/group-progress-heartbeats.ts:114-168`,
  `apps/core/src/runtime/group-processing.ts:489-503`). Note that
  `lastAgentProgressAt` is refreshed for **every** `AgentOutput`, not only
  `todo_update`/`render_progress`, so it measures provider-output silence
  (`apps/core/src/runtime/group-processing.ts:620-622`).
- The final-progress `elapsed` parameter is genuinely dead
  (`apps/core/src/runtime/progress-updates.ts:20-37`), but the claimed dead todo
  `elapsed` field is not: it changes header presence and rendered text
  (`apps/core/src/channels/agent-todo-render.ts:54-69`). Delete it only as an
  intentional no-duration contract change across its producers/tests, not as
  dead plumbing.
- Slack's `setTyping` is a no-op while structural capability detection treats
  any such method as support (`apps/core/src/channels/slack/channel-delivery.ts:669`,
  `apps/core/src/app/bootstrap/channel-capability-ports.ts:14-17`). Teams'
  reaction implementation is also a no-op (`apps/core/src/channels/teams.ts:247`).
- Telegram and Slack map `running`, but current ingress/admission callers send
  only `seen`; the “mapped but unsent” claim is correct
  (`apps/core/src/channels/telegram/reactions.ts:3-6`,
  `apps/core/src/channels/slack/reactions.ts:3-6`,
  `apps/core/src/application/external-ingress/conversation-message-ingress.ts:252-266`,
  `apps/core/src/app/bootstrap/live-execution.ts:314-324`).
- The heartbeat and agent progress card do **not** currently share one map. On
  Slack, host progress uses `activeProgress`, while `cardKind` keys use
  `pendingTodos`; Telegram likewise has separate `activeProgressMessages` and
  `pendingTodos` (`apps/core/src/channels/slack/channel-state.ts:138-148`,
  `apps/core/src/channels/slack/channel-delivery.ts:125-144,469-505`,
  `apps/core/src/channels/telegram/channel-state.ts:81-91`,
  `apps/core/src/channels/telegram/channel-delivery.ts:696-705`).
  `cardKind:'progress'` only selects the agent-todo key
  (`apps/core/src/runtime/ipc-rich-interaction-processing.ts:69-91`); it does not
  make `sendProgressToChannel` edit that card.
- `replaceOnly` is not a universal zero-post guarantee. Telegram drops a
  replace-only update when no handle exists, but after an edit failure it sends
  a fresh message without checking `replaceOnly`
  (`apps/core/src/channels/telegram/channel-delivery.ts:402-407,473-503`). Agent
  todo/progress renderers also fall back to fresh posts after edit failure on
  Slack and Telegram (`apps/core/src/channels/slack/agent-todo-delivery.ts:34-64`,
  `apps/core/src/channels/telegram/agent-todo-delivery.ts:27-59`).
- The host sender does reject nonterminal updates after finalization begins
  (`apps/core/src/runtime/group-progress-channel-sender.ts:15-35`), but that does
  not serialize an already-started heartbeat with an agent-card edit.

**Part B correction:** choose one owner and one serialized key for the single
progress card. Either route both heartbeat and agent progress through the same
`AgentTodoSink` `cardKind:'progress'` update lane, or explicitly suppress/remove
the host card when agent progress starts. Add a strict replace-only mode that
never falls back to posting after an edit failure, plus generation/finalization
tests. Until then, the stage invariant “zero new messages posted” is false.

### Staging verdict

The proposed `C -> B -> A` order is not valid because C contains B-dependent
heartbeat cleanup and an active todo elapsed renderer, while the document calls
the whole stage behavior-free (`apps/core/src/runtime/group-progress-heartbeats.ts:114-168`,
`apps/core/src/channels/agent-todo-render.ts:54-69`). Use this order:

1. Independent proven deletions only: final-progress elapsed and the stale Slack
   success matcher (`apps/core/src/runtime/progress-updates.ts:20-37`,
   `apps/core/src/channels/slack/thread-progress-status.ts:19-21`).
2. Part B together with its coupled heartbeat cleanup, but only after unifying
   card ownership and making replace-only strict at adapter fallbacks.
3. A5 as a small coordinated change using concurrent-but-awaited audit.
4. A4, with one final-context memory hydration and session fencing.
5. A1 last, because it adds durable history state and an off-path write contract.
6. **Split out A2's provider/agent/account collapse and A3** until the graph
   receipt and cursor-fenced replay contracts above exist. The safe A2 subset
   (startup-proven app/profile removal and the eight same-transaction thread
   identity/config repeats, after recency is pinned) may ship independently.

### Validated Surface Impact Matrix

| Surface                     | Classification          | Evidence/reason                                                                                                                                                                                                                                                                      |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime behavior            | **Changed**             | A1-A5 and heartbeat/admission paths are runtime behavior (`apps/core/src/runtime/group-conversation-context.ts:34-139`, `apps/core/src/runtime/group-processing.ts:94-110,489-503`).                                                                                                 |
| `settings.yaml`             | **Unchanged by design** | No validated fix requires a setting; persistence state belongs in Postgres and liveness can retain existing constants/sinks (`apps/core/src/adapters/storage/postgres/schema/conversations.ts:11-61`, `apps/core/src/runtime/group-progress-heartbeats.ts:114-168`).                 |
| Postgres/runtime projection | **Changed**             | A1 needs explicit durable history state; A2 changes canonical message graph writes (`apps/core/src/adapters/storage/postgres/schema/conversations.ts:11-61`, `apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts:240-467`).               |
| Control API                 | **Unchanged by design** | These seams are internal persistence/runtime delivery paths; no cited code crosses a control handler (`apps/core/src/app/bootstrap/channel-persistence-handlers.ts:143-262`).                                                                                                        |
| SDK/contracts               | **Changed**             | A3 needs a full cursor-fenced replay payload and A4 needs expected session identity across admission/runner (`apps/core/src/runtime/pending-message-replay.ts:77-96`, `apps/core/src/app/bootstrap/live-execution.ts:224-300`).                                                      |
| CLI                         | **Unchanged by design** | No CLI-owned configuration or command is involved in the cited runtime seams (`apps/core/src/app/bootstrap/channel-persistence-handlers.ts:143-262`).                                                                                                                                |
| Gantry MCP/admin skill      | **Unchanged by design** | No capability/admin mutation is part of the validated fixes; work remains inside message, session, gateway, and channel delivery seams (`apps/core/src/runtime/group-agent-runner.ts:149-175`, `apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts:489-519`). |
| Channel/provider adapters   | **Changed**             | Hydration, typing/reactions, and strict edit-only behavior cross channel adapters (`apps/core/src/app/bootstrap/channel-wiring-conversation-context.ts:19-35`, `apps/core/src/channels/slack/channel-delivery.ts:469-505,669`).                                                      |
| Docs/prompts                | **Changed**             | This goal prompt must carry these corrected contracts before stage execution (`AGENTS.md:203-204`).                                                                                                                                                                                  |
| Audit/events                | **Changed**             | A5 changes scheduling, but not content, of `credential.model.used`; OTel streaming remains independent (`apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts:502-580`, `apps/core/src/adapters/llm/observability/genai-spans.ts:350-497`).                     |
| Tests/verification          | **Changed**             | Add statement-count/first-contact/FK tests, cursor-race tests, exactly-once memory-hydration tests, retained-audit-before-handler-exit tests, and per-adapter zero-post edit-failure tests at the corresponding seams above.                                                         |
