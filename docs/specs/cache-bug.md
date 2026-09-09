---
slug: cache-bug
title: cache-bug — Retire oversized provider sessions across runner restarts
status: confirmed
saved: 2026-09-09T08:45:35+00:00
---

# cache-bug — Retire oversized provider sessions across runner restarts

## Why

Every persistent interactive runner start does two things at once: it resumes
the persisted provider session (which already holds every earlier user,
assistant and tool turn) AND it appends a freshly reconstructed briefing (up to
12,000 characters of durable memory plus up to 16,000 bytes of recent channel /
active thread context) as a new user turn. The per-turn briefing is a pinned
guarantee (decision 0089: every provider turn sees the channel block plus the
thread window; decision 0078: memory hydrates once per turn, with its
session-fence rehydration fallback) and stays as is. What is NOT bounded is
the transcript those briefings accumulate in: nothing expires a provider
session by age, turn count or size — the idle timeout only closes the runner's
stdin, and compaction fires only on explicit `/compact` or when the SDK
reaches the model's context window.

Production evidence (Slack): a one-word turn ("yes") read roughly 270k cached
input tokens on each of two model calls inside one execution (pre-tool and
post-tool), about 541k tokens for the turn. Prompt caching discounts the
repeated prefix; it does not remove it from the context window, stop stale
duplicate briefings reaching the model, or protect against cache misses.

Both execution adapters are affected, differently:

- Claude Agent SDK: model-visible context grows linearly until SDK autocompact
  at the context window (≈1M on the deployed model). Cost and latency grow.
- DeepAgents / LangChain: the library summarises at ~85% of a known window, so
  model-visible history is bounded, but the LangGraph Postgres checkpoint keeps
  the raw state, so checkpoint tables and checkpoint load latency grow instead.
  No application path owns checkpoint deletion.

Scheduled jobs already run non-persistent sessions on both adapters and are
out of scope. The runner is channel-neutral, so this applies to every channel
that holds a persistent interactive session, not only Slack.

Discovery: read-only Codex run `task-mttrhe3o-xh5mh1` (2026-09-09), plus the
Claude-adapter trace in `apps/core/src/runtime/group-agent-runner.ts`,
`apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-setup.ts`
and `apps/core/src/adapters/storage/postgres/repositories/canonical-session-repository.postgres.ts`.

Grill resolutions (spec gate, 2026-09-09; human decisions in rounds 1–5,
final cold read amended once per the one-read rule):
- Keep 0089 and 0078 unchanged; contain growth with a session-size ceiling
  only (a delta snapshot on resume is parked).
- MINIMAL scope: the ceiling uses per-run usage the adapters already report,
  corrected for provider cache semantics (`totalBillableInputTokens` subtracts
  cache reads and would never catch the 270k case). No per-request seam, no
  model-capacity clause, no retry system.
- This is a **retire-after-observed-crossing** rule, not a hard bound.
- Threshold is one global revisioned runtime setting per decision 0025.
- DeepAgents checkpoint rows are reclaimed through an adapter cleanup port on
  the named retirement paths only; orphans are an operator procedure.
- Pre-existing sessions are retired by a manual pre-deploy reset run by the
  deployment owner (decisions 0003 and 0112): no shipped command, no lazy
  retirement, and a deployment stop condition.
- Roadmap card: the acceptance criteria captured on `cache-bug` at intake
  predate grill convergence and the harness does not edit an active card's
  criteria. Human decision (round 5): this confirmed spec is LINKED to the
  card and is the story's authority; the intake criteria are superseded by
  the acceptance criteria below.

## Behaviour

1. **Model-visible input per run.** The host derives
   `modelVisibleInputTokens` from provider-resolved usage components of a
   run. The provider registry entry that already names the cache usage
   fields gains two booleans, `cacheReadsIncludedInInput` and
   `cacheWritesIncludedInInput`:
   - Anthropic (`cache_read_input_tokens`, `cache_creation_input_tokens`
     additive to `input_tokens`): both false →
     `inputTokens + cacheReadTokens + cacheWriteTokens`;
   - OpenAI-compatible (`prompt_tokens_details.cached_tokens` ⊆
     `prompt_tokens`): reads true, writes n/a → `inputTokens`;
   - no cache accounting → `inputTokens`.
   Mixed-provider or unresolved-provider usage uses the additive (largest)
   form; over-approximation only retires sooner. Each adapter must surface
   the usage it has accumulated so far on an error frame (Claude: the error
   path in `query-loop-phases-messages.ts` currently emits none; DeepAgents:
   the terminal snapshot), so costly errored turns cannot evade retirement.
   Because usage is per run, the figure over-approximates a single call's
   context; accepted for a retirement trigger. Billing fields and
   `totalBillableInputTokens` are unchanged.
2. **Typed per-session high-water mark, atomic and fenced.** A new nullable
   integer column `provider_sessions.context_high_water_mark` (decision 0017:
   resume-governing state is a typed column, never `metadata_json`). A new
   repository operation `raiseProviderSessionContextHighWaterMark({
   providerSessionId, agentSessionId, agentSessionResetAt, value })` runs one
   `UPDATE ... SET context_high_water_mark = GREATEST(COALESCE(existing, 0),
   value)` whose predicate fences on provider-session id, `agent_session_id`
   ownership, a resumable status, and `agent_sessions.reset_at` equal to the
   caller's generation, and returns whether a row changed. A non-integer or
   negative `value` is rejected before SQL. It is called after any run
   (including an errored run) whose output carries usage; runs without usage
   do not call it. The turn context projection returns
   `contextHighWaterMark` alongside the existing provider-session fields.
3. **Retire on resume when over the cap.** Preflight order: promote a
   `ready` row first (existing behaviour), then evaluate the mark on the
   selected row. If it exceeds the cap and the row is `active`, retire it via
   behaviour 5 and start a fresh session from the ordinary bounded briefing.
   A `maintenance_compact` row is never retired by the ceiling; it resumes
   or waits as today. Sessions at or under the cap, with no mark, or in
   maintenance resume exactly as today. The preflight adds no hydration
   beyond what 0078 specifies. Allowed overshoot: the one run that first
   exceeds the cap; the *next* resume retires it.
4. **Cap setting.** Canonical desired-state path
   `limits.provider_session_max_input_tokens`, a global scalar accepted by
   the strict limits parser alongside the existing flat
   `limits.<providerId>.requests_per_minute` entries; integer in
   20,000–900,000, default 150,000 when absent; rendered by the existing
   settings exporter; importable and exportable through the same YAML and
   control-API surfaces as `limits`; distributed through
   `settings_revisions`. Because the strict parser rejects unknown keys,
   `CURRENT_SETTINGS_READER_VERSION` is bumped and revisions carrying the key
   set that `min_reader_version`, so an older worker holds its prior revision
   and alerts (0025 skew contract) instead of failing. A lowered value takes
   effect on the next resume evaluated by a worker that has applied that
   revision. No environment variable, no per-agent override.
5. **Atomic retirement returning the retired reference.**
   `expireProviderSession` becomes one atomic `active`→`expired` transition
   fenced on provider-session id, `agent_session_id` ownership, status
   `active`, and `agent_sessions.reset_at`; it returns the retired
   `{ providerSessionId, externalSessionId, executionProviderId }` or nothing
   if no row transitioned. On a lost transition the host re-reads the turn
   context and proceeds with what it finds; it does not persist a replacement
   handle for a generation it does not own. Covered retirement paths:
   ceiling (new), missing-session, access-fingerprint change, and `/new`,
   whose reset selects the scoped provider-session references inside its
   transaction and hands them to cleanup only after commit. Explicitly NOT
   covered (retention stated): normal handle replacement (deletes the prior
   row without cleanup; DeepAgents thread ids are stable across runs so this
   is rare), agent and workspace removal cascades, and compaction failure or
   cancellation paths, which today reactivate the session and promise
   continuity to the user and keep doing so. Orphans from uncovered paths
   are the operator procedure in behaviour 7.
6. **Adapter cleanup port.** The execution-adapter contract gains an optional
   `releaseSession({ externalSessionId, runtimeStorage })` capability; the
   host calls it from a non-empty retirement result, passing the same
   `runtimeStorage` it passes to `prepare()`, after the reply path is
   unblocked. The DeepAgents adapter implements it by deriving the checkpoint
   schema exactly as `prepare()` does and calling the saver's
   `deleteThread(externalSessionId)`, which removes that thread's rows from
   `checkpoints`, `checkpoint_blobs` and `checkpoint_writes`; it is
   idempotent and on failure emits the cleanup-failed event of behaviour 8
   and leaves the session expired. The Claude adapter does not implement it.
   Core runtime stays provider-neutral: it never names a checkpoint table.
7. **Briefing, jobs, and operator procedures.** Every turn still receives
   the memory block and channel/thread snapshot exactly as 0089 and 0078
   require. Scheduled jobs are untouched. `docs/memory/` records:
   (a) the deployment owner's pre-deploy reset — drain live traffic, stop
   workers, select the interactive provider sessions (rows whose agent
   session has no `job_id` and a resumable status), delete the DeepAgents
   rows for exactly those `external_session_id`s from `checkpoints`,
   `checkpoint_blobs` and `checkpoint_writes` (never
   `checkpoint_migrations`), delete those provider-session rows, verify zero
   resumable interactive rows, then deploy; deploying with resumable
   interactive rows present is a stop condition because those sessions carry
   no mark and will resume normally; (b) the orphan reclamation procedure
   driven by cleanup-failed events and the uncovered paths in behaviour 5.
8. **Observability events.** Two registered runtime event types.
   `session.provider.retired` (payload: `reason` ∈ {ceiling, fingerprint,
   missing, new}, `providerSessionHash`, `executionProviderId`,
   `contextHighWaterMark`, `cap`) — for ceiling and fingerprint it is
   published at preflight with envelope `sessionId = agentSessionId` and no
   run id; for missing-session it is published after the failed attempt with
   that attempt's `runId`; for `/new` after commit with `sessionId`.
   `session.provider.cleanup_failed` (payload: `providerSessionHash`,
   `executionProviderId`, `error`). `providerSessionHash` is the full
   lowercase hex SHA-256 of the raw external session id, and the recipe joins
   with `encode(sha256(external_session_id::bytea), 'hex')`.
9. **Observability recipe.** An operator-only read-only SQL recipe in
   `docs/memory/`: per provider session (hashed), the typed mark and the
   per-run `model.usage` series via `agent_runs` LEFT JOIN `runtime_events`
   ordered by `agent_runs.started_at`, unioned with `session.provider.retired`
   events by hash and `agent_session_id`; plus DeepAgents checkpoint-table
   row counts per hashed thread id in the derived checkpoint schema.

## Acceptance criteria

1. Unit tests: `modelVisibleInputTokens` for an Anthropic usage of 1,000
   input / 270,000 cache read / 500 cache write is 271,500; for an
   OpenAI-compatible usage of 1,000 input / 800 cached is 1,000; a
   mixed-provider usage uses the additive form; billing fields unchanged.
2. Adapter tests: an errored Claude run and an errored DeepAgents run each
   surface the usage accumulated before the error.
3. Repository tests (Postgres): the raise operation keeps the larger value,
   leaves `metadata_json` untouched, rejects a stale owner, rejects a stale
   `reset_at` generation, ignores non-resumable rows, rejects invalid values
   before SQL, and reports whether a row changed; the migration adds the
   typed column.
4. Unit tests (host): a usage-bearing errored run raises the mark; a run
   with no usage does not call the operation.
5. Unit tests: a session with a mark over the cap is not passed as the resume
   id; retirement returns the reference; the run proceeds without resume; the
   replacement handle is persisted; the reply is delivered. A session whose
   run crosses the cap is retired on the following resume, not mid-run. A
   `maintenance_compact` row over the cap is not retired. A `ready` row is
   promoted before evaluation. A lost transition persists no replacement.
6. Unit test: a session at or under the cap, or with no mark, resumes and
   still carries the memory block and snapshot. Existing tests pinning that
   (`group-processing.test.ts` "passes hydrated memory context with provider
   session resume id", `agent-runner-ipc.test.ts` live-turn persist/resume,
   `claude-agent-sdk-boundary.integration.test.ts` memory+prompt user
   message, `deepagents-memory-context.test.ts`) stay green and untouched.
7. Settings tests: `limits.provider_session_max_input_tokens` parses next to
   provider entries, defaults to 150,000 when absent, rejects values outside
   20,000–900,000 with a path-level error, round-trips through export, is
   applied from a new revision by a current worker, and a worker below the
   bumped reader version holds its prior revision and alerts.
8. Postgres integration test (DeepAgents, using the existing
   `deepagents-checkpoint.postgres.integration.test.ts` harness and its
   isolated schema fixture): for ceiling, missing-session, fingerprint and
   `/new` paths, the retired thread's rows are removed from all three tables,
   `checkpoint_migrations` and other threads' rows remain; a second call is a
   no-op; a simulated deletion failure leaves the session expired, the reply
   delivered, and a `session.provider.cleanup_failed` event recorded; a lost
   retirement transition performs no cleanup.
9. Unit tests: `session.provider.retired` is emitted with the specified
   payload and timing per reason, carries `sessionId` or `runId` as stated,
   and is not dropped by event forwarding.
10. Scheduled-job tests are untouched and green.
11. `verify.py` green.
12. Both operator procedures and the observability recipe exist in
    `docs/memory/`, and the query runs against the current schema.

## Non-goals

- Changing what a turn's briefing contains (0089, 0078) or its limits. A
  delta snapshot on resume is parked: revisit if retirement alone leaves
  turns too expensive.
- A per-model-request context measurement or a model-capacity-aware cap
  (parked; revisit if the per-run figure proves too coarse).
- A hard mid-run bound; this rule retires after an observed crossing.
- Replacing cross-process resume with briefing-only reconstruction.
- Any shipped migration, cleanup, or lazy-retirement behaviour for
  pre-existing state (0003, 0112).
- Cleanup on handle replacement, agent/workspace removal cascades, or
  compaction failure paths; and any durable cleanup retry system.
- Fixing the DeepAgents usage normaliser's largest-not-summed billing
  accounting (separate defect; recorded as a deferral).
