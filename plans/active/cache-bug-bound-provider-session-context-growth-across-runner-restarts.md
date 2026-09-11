---
issue: cache-bug
title: Bound provider-session context growth across runner restarts
status: approved
saved: 2026-09-11T11:32:18+00:00
story: cache-bug
decisions_reviewed:
  - 0000-credential-broker-boundary
  - 0001-agent-runtime-platform
  - 0002-symphony-forge-adoption
  - 0003-early-stage-no-backcompat
  - 0004-gantry-naming-and-public-repo
  - 0005-runtime-stack
  - 0006-config-secret-source-boundary
  - 0007-settings-runtime-truth
  - 0008-storage-backend-cutover
  - 0009-canonical-domain-schema-cutover
  - 0010-claude-runtime-materialization
  - 0011-provider-session-artifact-store
  - 0012-browser-capability-boundary
  - 0013-runtime-event-exchange
  - 0014-external-ingress-vs-outbound-webhooks
  - 0015-model-catalog-and-cache-accounting
  - 0016-event-bus-outbox-boundary
  - 0017-jsonb-runtime-payload-boundary
  - 0018-provider-neutral-agent-execution-adapter
  - 0019-simple-permission-and-job-tool-lifecycle
  - 0020-mcp-source-vs-action-capability
  - 0021-capability-artifacts
  - 0022-delivery-vehicle
  - 0023-deployment-modes
  - 0024-locked-preset
  - 0025-settings-authority
  - 0027-process-roles-and-multi-live
  - 0028-agent-harness-selection
  - 0029-agent-communication-reaction-binding
  - 0030-agent-communication-reasoning-safety
  - 0031-send-message-files-authority
  - 0032-signed-artifact-links-deferred
  - 0033-teams-reactions-deferred
  - 0034-client-signoff
  - 0035-epics-approved
  - 0040-permission-execution-two-axis-model
  - 0041-client-signoff
  - 0042-decision-view-16k-prefix-stripped
  - 0043-classifier-risk-only-engine-authz
  - 0044-ci-runner-isolation
  - 0045-inbound-attachment-descriptor-writer
  - 0046-llm-process-local-admission
  - 0050-agent-removal-projection-cleanup
  - 0051-client-signoff
  - 0052-birthright-self-surface
  - 0053-permission-no-timeout-interactive
  - 0054-decision-provenance-and-risk-label
  - 0055-client-signoff
  - 0056-durable-cancellation-invariant
  - 0057-arch1-client-signoff
  - 0058-readonly-scheduler-birthright
  - 0062-perm6-client-signoff
  - 0063-perm7-client-signoff
  - 0064-client-signoff
  - 0065-perm8-client-signoff
  - 0066-race-1-skill-artifact-app-isolation
  - 0067-client-signoff
  - 0068-race-2-cluster-fenced-settings-projection
  - 0069-client-signoff
  - 0070-client-signoff
  - 0071-race-4-browser-profile-lock-aba
  - 0072-client-signoff
  - 0073-race-6-profile-mirror-version-guard
  - 0074-race-8-mandatory-atomic-async-admission
  - 0075-race-9-serialize-file-backed-settings-write
  - 0076-client-signoff
  - 0077-race-5-lease-loss-lifecycle
  - 0078-lat-3a-single-memory-hydration-per-turn
  - 0079-client-signoff
  - 0080-lat-3b-retain-authoritative-second-fetch
  - 0081-client-signoff
  - 0082-fence-1-durable-lease-generation
  - 0083-conv-001-client-signoff
  - 0084-client-signoff
  - 0085-lat-4a-fused-inbound-envelope-transaction
  - 0086-client-signoff
  - 0087-lat-5-durable-provider-history-coverage
  - 0088-client-signoff
  - 0089-thread-turns-read-channel-context
  - 0090-sender-allowlist-trigger-only
  - 0091-client-signoff
  - 0092-client-signoff
  - 0093-client-signoff-is-a-pinned-project-gate
  - 0094-conversation-file-trust-program
  - 0095-client-signoff
  - 0096-thread-recency-message-timestamp
  - 0097-public-session-conversation-aggregate
  - 0098-streamed-message-projection-timing
  - 0099-rate-limits-singleton-authority
  - 0100-mig-1-client-signoff
  - 0101-oidc-generic-google-first
  - 0102-runtime-hardening-audit-harvest
  - 0103-live-admission-terminal-retention
  - 0104-co-1-recovery-intent-reframe
  - 0105-physical-attachment-workspace-handoff
  - 0106-scheduled-runs-cannot-mutate-jobs
  - 0107-typed-permission-decision-provenance
  - 0108-job-definition-revision-fencing
  - 0109-semantic-capability-job-dependencies
  - 0110-live-ux-capability-dispatcher
  - 0112-legacy-single-canonical-shape
  - 0113-enforce-no-backcompat-architecture-check
  - 0114-canonical-job-owner
  - 0115-autonomous-tool-denial-terminal
  - 0117-scheduled-job-declare-tools-at-creation
  - 0118-identity-scoped-approval-and-grants
  - 0119-provider-neutral-group-approver-bootstrap
  - 0120-local-cli-structured-invocation
  - 0122-capability-template-amendment
  - 0123-recovery-proposal-birthright
  - 0124-bounded-durable-card-delivery
  - 0125-host-only-template-amendment
  - 0126-typed-terminal-denial-event
  - 0127-tagged-setup-action-model
  - 0128-permission-approval-result
  - 0129-capsafe-local-cli-terminal-wildcard
  - 0130-capsafe-capability-run-dispatch-only
  - 0132-adaptive-browser-authentication-access
  - 0133-gantry-tool-correlation-response-meta
  - 0134-autonomous-compound-runcommand-leaf-authorization
  - 0135-browser-model-provider-credential-facade
  - 0136-voice-as-provider-adapter
  - 0137-connector-accounts-mirror-provider-accounts
  - 0138-agents-are-service-kind-persons
  - 0142-third-console-role-approver
  - 0143-browser-write-only-secret-ingest
  - 0144-autonomous-ask-and-wait-chat-parity
  - 0151-browser-navigation-summary
  - 0153-learned-decisions-project-into-job-grants
  - 0154-human-decision-memory-generic-scope
  - 0155-default-allow-gantry-tools-interactive-auto
  - 0156-ai-employee-console-resumable-deployment
  - 0157-jobs-use-the-chat-permission-ladder
  - 0158-provider-session-context-ceiling
  - 0159-adapter-session-release-port
  - 0160-physical-column-naming-is-snake-case
---

# cache-bug — Retire oversized provider sessions across runner restarts

Spec: `docs/specs/cache-bug.md` (confirmed, linked; its twelve acceptance
criteria supersede the intake-time card criteria). Requirements-gate
resolutions R1–R7 (recorded in `.factory/stories/cache-bug/grills/`) are
binding here and are mapped to tasks below. Decisions 0158 and 0159 are
accepted and attested in the frontmatter.

## Problem

Every persistent interactive runner start resumes the stored provider session
and appends a fresh bounded briefing (0078, 0089). The briefing is bounded;
the transcript is not: nothing expires a provider session by size, the idle
timeout only closes runner stdin, and compaction is explicit or at the model's
context window. A one-word Slack turn read ~270k cached tokens twice. Claude
sessions grow in model-visible context; DeepAgents sessions grow in LangGraph
checkpoint rows. No application path deletes DeepAgents checkpoints.

## Scope / Non-goals

In scope: a typed per-session context high-water mark raised after each run;
a global cap that retires an over-cap session on its next resume through one
atomic transition that returns the retired reference; a provider-neutral
`releaseSession` port that DeepAgents implements with `deleteThread`; `/new`
(active and idle paths) returning retired references and releasing them after
the reply; two runtime events published best-effort by the host; adapters
surfacing one cumulative partial-usage payload on error frames; registry
cache-inclusion booleans and the resolved route on every usage result;
operator procedures and an executed observability recipe in `docs/memory/`;
alignment of `docs/architecture/runtime-components.md` and
`docs/architecture/canonical-domain-model.md` with `session-resume.md`; and a
core lint gate in `verify.py` and CI.

Non-goals (spec, 0158, 0159): changing the briefing or its limits; a
per-request measurement seam or model-capacity cap; a hard mid-run bound;
briefing-only reconstruction; any data migration, cleanup flow or lazy
retirement for pre-existing sessions (0003, 0112 — the generated schema
migration that adds the column is the only migration); release on handle
replacement, agent or workspace removal, the compaction-delta degradation
path (keeps expiring, uncovered), or compaction maintenance failure paths; a
cleanup retry system; the DeepAgents largest-not-summed billing defect.

## Acceptance Criteria

Spec criteria S1–S12 and requirements resolutions R1–R7; each names the task
that serves it.

- S1 (T1) derivation: Anthropic 1,000 / 270,000 / 500 → 271,500;
  OpenAI-compatible 1,000 input / 800 cached → 1,000; mixed route additive;
  billing fields unchanged.
- S2 (T1) an errored Claude run and an errored DeepAgents run each surface
  the usage accumulated before the error.
- S3 (T1) repository: raise keeps the larger value, leaves `metadata_json`
  untouched, rejects a stale owner, rejects a stale `reset_at` generation,
  ignores non-resumable rows, rejects invalid values before SQL, reports
  whether a row changed; the migration adds the typed column.
- S4 (T2) a usage-bearing errored run raises the mark; a run with no usage
  does not call the operation.
- S5 (T2) over-cap session is not passed as the resume id; retirement returns
  the reference; the run proceeds fresh; the replacement handle is persisted;
  the reply is delivered; a crossing run is retired on the following resume,
  not mid-run; a `maintenance_compact` row is not retired; a `ready` row is
  promoted first; a lost transition persists no replacement.
- S6 (T2) under-cap or unmarked sessions resume with the memory block and the
  snapshot; the four pinned tests (`group-processing.test.ts` "passes
  hydrated memory context with provider session resume id",
  `agent-runner-ipc.test.ts` live-turn persist/resume,
  `claude-agent-sdk-boundary.integration.test.ts` memory+prompt user message,
  `deepagents-memory-context.test.ts`) stay green and untouched.
- S7 (T2) `limits.provider_session_max_input_tokens` parses next to provider
  entries, defaults to 150,000, rejects outside 20,000–900,000 with a
  path-level error, round-trips through export and the revision document, is
  applied from a new revision by a current worker, and a worker below the
  bumped reader version holds its prior revision and alerts.
- S8 (T3) DeepAgents Postgres integration: for ceiling, missing-session,
  fingerprint and `/new`, the retired thread's rows leave all three tables,
  `checkpoint_migrations` and other threads remain, a second call is a no-op,
  a simulated failure leaves the session expired, the reply delivered and
  `session.provider.cleanup_failed` recorded, and a lost transition performs
  no cleanup.
- S9 (T2 for the event types and the ceiling, fingerprint and
  missing-session publications; T3 for the `/new` publication, which needs
  both `/new` handlers) `session.provider.retired` is emitted with the
  specified discriminated payload and timing per reason, carries `sessionId`
  or `runId` as stated, and is not dropped. Split deliberately: a single
  owner could not finish it, because the event types and the handlers sit in
  different tasks.
- S10 (T1, T2, T3) scheduled-job tests untouched and green.
- S11 (all) `verify.py` green, now including the diff-scoped
  `npm run lint:changed`.
- S12 (T2) operator procedures and recipe in `docs/memory/`; the query is
  executed by a Postgres test against the current schema.
- R1 (T1) null-safe generation fence: null/null succeeds, null vs non-null
  rejects, on both raise and retire.
- R2 (T1) one cumulative partial-usage payload with the stable usage
  identifier on the error frame; the host records the mark exactly once.
- R3 (T1) every executable route declares both cache-inclusion booleans; a
  route missing one fails registry validation; nonzero OpenAI/OpenRouter
  cache-write usage yields `inputTokens` unchanged; DeepAgents usage carries
  its resolved route.
- R4 (T1 return type, T3 wiring) `resetScope` returns immutable retired
  references after commit; both `/new` handlers reply before release.
- R5 (T2 events, T3 sanitiser) events carry app and actor context, are
  best-effort, and have publish, query and projection tests; the cleanup
  error contains no external session id, thread id or connection string.
- R6 (T2) a lost retirement race re-reads with `hydrateMemory: false` and
  reuses the hydrated block when the generation matches.
- R7 (T2) `runtime-components.md` and `canonical-domain-model.md` no longer
  state that fresh runs restore memory only.

## Technical Approach

**Measurement (0158 §2).** Prefer `output.contextUsage.totalTokens`
(`RuntimeContextUsageSnapshot`, produced by the Claude runner via
`readContextUsage` and by DeepAgents via `terminalContextUsage`). Fall back to
`modelVisibleInputTokens(usage)` in `apps/core/src/shared/model-usage.ts`,
driven by two new required booleans on every `cacheSupport.prompt` registry
entry (`model-provider-registry.ts`, `model-provider-registry-openai-compatible.ts`):
Anthropic false/false, OpenAI and OpenRouter true/true, no-cache routes
true/true; the registry validator refuses an executable route missing either.
The DeepAgents normaliser (`runner/stream-normalizer.ts`) carries
`provider`/`modelRoute` on the normalised usage. T1 sets BOTH from
`input.provider`, so cache policy resolves at provider granularity through the
documented `usage.modelRoute ?? usage.provider` fallback; passing the genuinely
resolved registry route needs the host-to-runner input contract widened and is
**T2's** work (deferral D-0083), not T1's.

Partial usage on error: `DeepAgentPartialUsage` (in
`runner/stream-normalizer-partial-usage.ts`) IS the thrown value — there is no
separate wrapper type — carrying the accumulated usage, the context-usage
snapshot and the turn's `usageEventId`; `deep-agent-runner.ts` propagates it
and `runner/index.ts` writes it as `usage` on the single error frame. A
close-driven abort is the exception: it keeps its own identity and the partial
usage rides on it as a non-enumerable property, so a graceful stop never
becomes an error frame. Tool-permission denials and denial-driven aborts carry
usage the same way. Both inline lanes (`deepagents-langchain/inline-lane` and
`anthropic-claude-agent/inline-lane`) emit one terminal error output carrying
the accumulated usage. Claude: the `result` error branch in
`query-loop-phases-messages.ts` normalises the message's usage before
throwing and the runner's error frame carries it.

**Storage (0158 §1, 0017).** Drizzle schema adds
`contextHighWaterMark: integer('context_high_water_mark')` (nullable — the
physical name is snake_case per decision 0160, which records this repository's
deliberate deviation from the camelCase standard) to
`providerSessionsPostgres`; migration generated with
`npm run db:migrations:generate -- --name provider_session_context_high_water_mark`
(never hand-written; `db:migrations:check` stays clean). Repository helper
`raiseProviderSessionContextHighWaterMark` runs one `UPDATE provider_sessions
SET context_high_water_mark = GREATEST(COALESCE(context_high_water_mark,0), $v),
updated_at = now() FROM agent_sessions WHERE provider_sessions.id = $id AND
provider_sessions.agent_session_id = $sid AND agent_sessions.id = $sid AND
provider_sessions.status IN (resumable) AND agent_sessions.reset_at IS NOT
DISTINCT FROM $gen` and returns `rowCount > 0`. A typed domain error
`ProviderSessionMeasurementError` rejects non-integer or negative values
before SQL. `providerSessionContext` returns `contextHighWaterMark`.

**Retirement (0158 §3).** A NEW `retireProviderSession` joins the existing
`expireProviderSession`: `UPDATE ... SET status='expired', updated_at=now()
FROM agent_sessions WHERE id AND agent_session_id AND provider AND
external_session_id AND status='active' AND reset_at IS NOT DISTINCT FROM
$gen RETURNING id, external_session_id, provider`, returning the retired
reference or `undefined`. THREE callers switch to it: fingerprint
(`group-agent-runner.ts:391`), missing-session (`:503`), and the
`canonical-session-ops-service.ts` facade with its
`canonical-ops-repo.postgres.ts` twin. The compaction-delta degradation path
(`group-agent-runner-compaction-delta.ts:104`) does NOT switch: it operates on
a `ready` row and keeps calling `expireProviderSession` unchanged, performing
no release and emitting no retirement event, per decision 0159 §4. New ceiling preflight in
`group-agent-runner.ts` after `prepareCompactionDeltaReplay` and the
fingerprint check: if `turnContext.contextHighWaterMark > cap` and the row is
`active`, call `retireProviderSession`; on success clear the resume ids,
publish `session.provider.retired` (reason `ceiling`, `sessionId =
agentSessionId`, no run id), and enqueue the release for after the reply; on
a lost transition re-read via the existing `fencedFinalContext` pattern
(`hydrateMemory: false`, carry the block when agent session id and
null-normalised `resetAt` match) and persist no replacement. `ready`
promotion already precedes this inside `getAgentTurnContext`;
`maintenance_compact` is excluded by the `status='active'` predicate. After
each run, in `wrappedOnOutput` beside `persistProviderSessionFromOutput`,
compute the observed value and call the raise operation when a measurement
exists, including on `status: 'error'` outputs that carry usage.

**Setting (0158 §3, 0025).** `parseLimitsSettings` accepts the scalar key
`provider_session_max_input_tokens` beside provider mappings;
`RuntimeLimitSettings` gains `providerSessionMaxInputTokens: number`;
`runtime-settings-defaults.ts` supplies 150,000; validation is 20,000–900,000
with a path-level error; `settings-revision-document.ts` serialises and
re-hydrates it under `limits`; `desired-state-current-export.ts` and the YAML
renderer emit it; `CURRENT_SETTINGS_READER_VERSION` in
`settings-fleet-import.ts` goes 15 → 16 — the importer already stamps every
subsequent revision with the current reader version, so no per-key
conditional is built; older workers hold their last revision and alert
(0025 skew contract). The runner reads the cap through the settings accessor
pattern used by `createConfiguredRunTokenBudget`.

**Release port (0159).** `AgentExecutionAdapter.releaseSession?(input)` in
`application/agent-execution/agent-execution-adapter.ts`; DeepAgents
`execution-adapter.ts` implements it with `deepAgentsCheckpointSchema` and a
short-lived `PostgresSaver` calling `deleteThread`. T3 owns the complete
release coordinator `apps/core/src/runtime/provider-session-release.ts`:
resolve the adapter via `resolveAgentExecutionAdapter` by
`executionProviderId`, run after the turn's final reply path has unblocked
(queued from ceiling and fingerprint preflight and from the missing-session
retry, drained once at the end of `runAgent`), sanitise the error (strip the
external session id, thread id and any `postgres://` URL), and publish
`session.provider.cleanup_failed` best-effort. `resetScope` (T1) returns the
retired references selected `FOR UPDATE` before delete and returned after
commit; `canonical-session-ops-service.ts` and `app.clearSessionForChatJid`
propagate them; both `/new` handlers — idle in `session/session-commands.ts`
and active in `app/bootstrap/runtime-services-active-new.ts` — send their
reply, then call the coordinator (T3).

**Events (0013).** Register `SESSION_PROVIDER_RETIRED:
'session.provider.retired'` and `SESSION_PROVIDER_CLEANUP_FAILED:
'session.provider.cleanup_failed'` in `domain/events/runtime-event-types.ts`
with typed payloads in `domain/events/events.ts`; owner: the runtime
(group-agent-runner and the release coordinator). Publish through
`deps.publishRuntimeEvent` directly with `appId`, `actor` (the runtime
principal used by existing runner events), `sessionId`, and `runId` when
applicable; publication is best-effort and never suppresses the reply.
Tests cover publish, query (`runtime_events` filter by type and session) and
projection (the run listing consumers ignore the new family cleanly).

Hash: `createHash('sha256').update(externalSessionId).digest('hex')` — the RAW
EXTERNAL session id, never the internal `provider_sessions.id`. The documented
operator SQL joins on the hash of the external id, so hashing the internal id
would produce a value that silently matches nothing.

Publication is best-effort and never suppresses the reply, but it must never
be the only record: when publishing `session.provider.cleanup_failed` itself
fails, the coordinator emits a structured error log carrying the same hashed
external session id and the sanitised cause, so a checkpoint orphaned by a
double failure still leaves evidence for the operator scan. Swallowing both
would violate the no-swallowed-errors and structured-logging rules
(`constitution/07-exception-handling.md`, `05-logging-and-observability.md`).
A test drives the publication failure and asserts the log.

**Quality gate.** Core ESLint exists (`npm run lint`) but neither `verify.py`
(`.envrc` `FACTORY_STRUCTURAL_CMD`) nor CI runs it. T1 adds a diff-scoped
`npm run lint:changed` — ESLint over the TypeScript files changed against the
merge-base with origin/main — to `FACTORY_STRUCTURAL_CMD` and as the BLOCKING
CI check step, while full `npm run lint` runs as an advisory
continue-on-error CI step. Gating on full lint would fail every branch on the
82 pre-existing errors, so the diff-scoped gate is what blocks and the debt
is a recorded deferral.

**Docs.** `docs/memory/provider-session-ceiling-operations.md` carries the
pre-deploy reset (drain, stop workers, select interactive sessions by
`agent_sessions.job_id IS NULL AND provider_sessions.status IN (resumable)`,
delete their rows from the three checkpoint tables — never
`checkpoint_migrations` — delete the provider-session rows, verify zero,
deploy; stop condition stated), the orphan scan, and the observability SQL;
a Postgres test executes THE SQL EXTRACTED FROM THE DOCUMENT (or from a
shared SQL artifact the document includes), never a copy pasted into the
test — a duplicated query stays green while the operator-facing recipe
drifts, which is the failure this proof exists to catch. `runtime-components.md` and
`canonical-domain-model.md` are aligned with `session-resume.md`: a run with
no provider handle is memory-only; a live run with a trusted stored handle
may resume it and may be retired by 0158.

Rejected simpler shape: a ceiling on `totalBillableInputTokens` (subtracts
cache reads; never fires on the reported case). Rejected larger shapes are
recorded in 0158 and 0159.

## Decisions

- `docs/decisions/0158-provider-session-context-ceiling.md` (accepted) — the
  ceiling rule, metric preference, typed column, global setting, no data
  migration.
- `docs/decisions/0159-adapter-session-release-port.md` (accepted) —
  provider-neutral release port, `/new` returning references, covered and
  uncovered paths including the compaction-delta degradation path.
- `docs/decisions/0160-physical-column-naming-is-snake-case.md` (accepted) —
  physical columns are snake_case, deviating deliberately from the camelCase
  standard; recorded so `context_high_water_mark` is a documented choice
  rather than an unexplained divergence.

Tooling: no new packages. Drizzle migrations via `db:migrations:generate`,
Vitest for unit and Postgres integration tests, the existing
`deepagents-checkpoint.postgres.integration.test.ts` harness, ESLint already
configured — all installed and the only fit for this repo.

## Surface Impact

| Surface | Class | Note |
| --- | --- | --- |
| Runtime behaviour | Changed | over-cap sessions retire on next resume; DeepAgents retired threads released after reply; both `/new` paths release |
| API | Changed | no new route, but `limits.provider_session_max_input_tokens` changes the typed JSON that `/v1/settings/desired-state` ACCEPTS and RETURNS, so the public payload shape moves; it rides the existing desired-state CRUD and the `limits` revision document |
| Data/schema | Changed | `provider_sessions.context_high_water_mark` (generated migration); `resetScope` return type; `retireProviderSession` return type |
| CLI/ops | Changed | new `limits.provider_session_max_input_tokens` key with defaults/export; reader version 16; operator procedures in docs/memory; `npm run lint:changed` blocking in verify and CI, full lint advisory |
| UI | N-A | no console surface |
| Docs | Changed | docs/memory procedures + executed recipe; `runtime-components.md` and `canonical-domain-model.md` aligned |
| Tests | Changed | unit, repository, settings, event and Postgres integration tests per task; four pinned tests untouched |
| Deferred | Recorded | D-0086 per-request measurement seam and model-capacity cap; D-0087 delta snapshot on resume; D-0088 DeepAgents largest-not-summed billing. Each carries its own trigger in `plans/deferrals.md` — recorded now rather than at story close, so nothing depends on a future closeout action |

## Task Decomposition

1. `cache-bug-T1` — Measurement, storage, and the quality gate.
   `user_facing: false`. Registry booleans + validator;
   `modelVisibleInputTokens`; DeepAgents normaliser receives and carries the
   resolved route; typed partial-usage carrier through
   `stream-normalizer → deep-agent-runner → index`; Claude error-branch usage;
   schema column + generated migration; `raiseProviderSessionContextHighWaterMark`
   with `ProviderSessionMeasurementError`; `retireProviderSession` returning
   the reference with THREE callers switched (fingerprint, missing-session,
   ops-service facade and its `canonical-ops-repo.postgres.ts` twin) while the
   compaction-delta path keeps `expireProviderSession` unchanged (0159 §4 — it
   operates on a `ready` row, which the new helper's `active` predicate would
   not match); `resetScope` returning references
   through `canonical-session-ops-service.ts` and `clearSessionForChatJid`;
   turn-context projection; `npm run lint:changed` in `.envrc` and CI. Serves S1, S2,
   S3, S10, S11, R1, R2, R3, R4 (return type). Write scope:
   `apps/core/src/shared/model-usage.ts`,
   `apps/core/src/shared/model-provider-registry*.ts`,
   `apps/core/src/adapters/llm/deepagents-langchain/runner/{stream-normalizer,deep-agent-runner,index}.ts`,
   `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-messages.ts`,
   `apps/core/src/adapters/storage/postgres/schema/sessions.ts` + `migrations/`,
   `apps/core/src/adapters/storage/postgres/repositories/canonical-session-repository*.ts`,
   `apps/core/src/adapters/storage/postgres/services/canonical-session-ops-service.ts`,
   `apps/core/src/adapters/storage/postgres/schema/canonical-ops-repo.postgres.ts`,
   `apps/core/src/runtime/group-agent-runner.ts` (the fingerprint and
   missing-session callers), `apps/core/src/app/bootstrap/runtime-app.ts` and
   `runtime-services-active-new.ts` (retired-reference propagation through
   `clearSessionForChatJid`), `apps/core/src/domain/sessions/provider-session-measurement.ts`,
   `apps/core/src/adapters/llm/deepagents-langchain/runner/{stream-normalizer-partial-usage,stream-normalizer-usage}.ts`,
   `apps/core/src/adapters/llm/deepagents-langchain/inline-lane/` and
   `apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/`,
   `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-failure.exception.ts`,
   `apps/core/src/domain/repositories/ops-repo.ts`, `package.json` (the
   `lint:changed` script), `.envrc`, `.github/workflows/ci.yml`, tests.
   NOT in scope: `group-agent-runner-compaction-delta.ts` — that call site is
   deliberately unchanged.
   reviewer_focus: types, constants, domain error, data-access, mapping in
   their own files; one SQL statement per operation; no JSONB for the mark;
   null-safe fences; validation before SQL; the DeepAgents partial-usage
   carrier is a typed value (`DeepAgentPartialUsage`) thrown directly, while
   Claude's is a typed `Error` subclass (`QueryFailure` in
   `runner/query-failure.exception.ts`) — both carry usage as declared fields,
   neither bolts ad-hoc properties onto a bare `Error`.
2. `cache-bug-T2` — Ceiling policy, the cap setting, and event types.
   `user_facing: false`. Depends on T1. Serves S4, S5, S6, S7, S10, S12,
   R6, and the event-type half of S9.

   Limits parser, types, defaults, revision document, export and YAML
   renderer with reader version 16. Ceiling preflight and post-run raise in
   `group-agent-runner.ts`: the preflight sits AFTER
   `prepareCompactionDeltaReplay` and the fingerprint check so a `ready` row
   is promoted first, and evaluates the mark on the selected row only.

   THE OVERFLOW CLAMP (verified gap, and T2 owns it because it owns the
   measurement path): `provider_sessions.context_high_water_mark` is a
   Postgres `integer` (`schema/sessions.ts:89` and the merged migration),
   while `assertProviderSessionContextHighWaterMark`
   (`domain/sessions/provider-session-measurement.ts:16`) validates only
   "non-negative integer". An observation above 2,147,483,647 therefore
   reaches SQL and fails, leaving an over-cap session unmarked and resumable
   — the exact outcome the ceiling exists to prevent. T2 clamps the stored
   value at 2,147,483,647, the COLUMN's limit, with a unit test at the clamp
   boundary. T1 is sealed and cannot carry this.

   The clamp must NOT be tied to the cap setting's maximum. An earlier draft
   used 900,001, one above the largest configurable cap (20,000–900,000),
   which silently coupled a policy range to a storage limit: a real mark can
   exceed 900,001 on a ≈1M-context model, and widening the cap range past
   900,000 would leave a clipped mark failing to exceed the cap — ending
   retirement for exactly the sessions it targets, undetectably. The
   reviewer checks that the clamp constant derives from the column type, not
   from the limits parser's bounds.

   R6: on a LOST ceiling transition, re-read the turn context with
   `hydrateMemory: false` and reuse the carried memory block ONLY when the
   generation still matches; on a mismatch, discard the carried block and
   rehydrate, because decision 0078's exactly-once guarantee is per turn and
   a mismatch means a concurrent reset. Regression coverage for BOTH
   branches — reusing on match and rehydrating on mismatch — since an
   implementation that only handles the match branch would leak a stale
   session's memory.

   Event TYPES and non-`/new` publication: register both types with typed
   payloads, discriminated on `reason` so `contextHighWaterMark` and `cap`
   exist only for `reason = ceiling`. Making that discrimination
   compile-time safe requires changing the publish contract:
   `RuntimeEventPublishInput` carries `payload: unknown`
   (`domain/events/events.ts:76`), so standalone interfaces in `events.ts`
   bind nothing. Either narrow the publish input for these families or
   publish through a typed helper that does; the reviewer checks that a wrong
   payload for a `reason` fails to compile. No event family in this
   repository carries a `version` field today, so these follow the existing
   convention; if canon requires versioning, that deviation gets its own
   decision rather than a one-off versioned family here.

   T2 publishes ceiling, fingerprint and missing-session events. It does NOT
   publish the `/new` event — T3 owns both `/new` handlers.

   `docs/memory` procedures and the executed observability recipe, plus the
   architecture alignment already applied to `runtime-components.md` extended
   to `canonical-domain-model.md` (R7).

   Write scope:
   `apps/core/src/config/settings/{runtime-settings-limits-parser,runtime-settings-types,runtime-settings-defaults,settings-revision-document,settings-fleet-import,desired-state-current-export}.ts`
   and the YAML renderer, `apps/core/src/runtime/group-agent-runner.ts`,
   `apps/core/src/domain/sessions/provider-session-measurement.ts` (the
   clamp), `apps/core/src/domain/events/{runtime-event-types,events}.ts`,
   `docs/memory/provider-session-ceiling-operations.md`,
   `docs/architecture/canonical-domain-model.md`, tests.
   NOT in scope: the resolved model route. It is already correct — the host
   projects `effectiveModelEntry.modelRoute.id` into
   `GANTRY_DEEPAGENTS_MODEL_PROVIDER` (`execution-adapter.ts:134`), the
   runner reads it (`runner/index.ts:58`) and passes it as `input.provider`
   (`:143`), so `usage.modelRoute` already carries the resolved route.
   Deferral D-0083 asserted otherwise and is withdrawn; see lesson 157.
   reviewer_focus: policy in a thin coordinator; cap read once per turn; the
   clamp is at the domain boundary, not in SQL; both R6 branches proven;
   event payload discrimination that actually fails to compile when wrong.

3. `cache-bug-T3` — Release port, cleanup coordinator, and the `/new` paths.
   `user_facing: false`. Depends on T2. Serves S8, S10, R4, R5, and the
   `/new` half of S9.

   `releaseSession` on the adapter contract; the DeepAgents implementation
   via `deleteThread`; `provider-session-release.ts` coordinator with
   adapter-registry resolution, the error sanitiser, and `cleanup_failed`
   publication. When that publication ITSELF fails, emit a structured error
   log carrying the hashed external session id and the sanitised cause, so a
   double failure still leaves evidence for the operator scan.

   THE RETIRED REFERENCE GAINS `agentSessionId` (verified gap):
   `RetiredProviderSessionReference`
   (`domain/sessions/provider-session-measurement.ts:10`) has three fields,
   and both producers project exactly those three — `retireProviderSession`'s
   `.returning({...})` at `canonical-session-repository-context-mark.postgres.ts:114`
   and `resetProviderSessionScope`'s `.select({...})` at `:180`. The reset
   already filters on `agentSessionId` at `:186`, so the query change is
   trivial; the cost is propagating the widened type through the ops port and
   both facades. Decision 0159 §3 requires it so `/new` can publish one event
   per retired row from the same committed read instead of a boundary lookup
   that can fail while the reset succeeds.

   THE DRAIN BOUNDARY IS IN `group-processing.ts`, NOT THE RUNNER (verified):
   `runAgent` is awaited at `runtime/group-processing.ts:669` and
   `finalizeGroupAgentUserVisibleOutput` runs at `:778`, after it. A drain at
   the end of `runAgent` would therefore precede or delay the fallback reply.
   Cleanup runs after the COMPLETE primary-plus-fallback attempt settles,
   success or failure, never blocking and never throwing through delivery.

   THE IDLE `/new` PATH NEEDS A CONTRACT CHANGE (verified):
   `clearCurrentSession` is declared `() => Promise<void> | void`
   (`session/session-commands.ts:176`) and called at `:316`; its only
   supplier is `group-processing-session-command-handlers.ts:174`, which
   delegates to `deps.clearSession` and discards the result. Nothing can
   carry retired references out of the idle path until that return type
   widens, so T3 owns the contract, the handler and the supplier — this is a
   command-surface change, not wiring.

   Write scope:
   `apps/core/src/application/agent-execution/agent-execution-adapter.ts`,
   `apps/core/src/adapters/llm/deepagents-langchain/{execution-adapter,checkpoint-setup}.ts`,
   `apps/core/src/runtime/provider-session-release.ts` (new),
   `apps/core/src/runtime/group-processing.ts` (the drain boundary),
   `apps/core/src/runtime/group-processing-session-command-handlers.ts`,
   `apps/core/src/runtime/group-processing-types.ts`,
   `apps/core/src/session/session-commands.ts`,
   `apps/core/src/domain/sessions/provider-session-measurement.ts` (the
   fourth field), the repository, ops port and facades that propagate it,
   `apps/core/src/app/bootstrap/{runtime-app,runtime-services-active-new}.ts`,
   tests.
   reviewer_focus: the adapter owns storage knowledge and the host never
   names a checkpoint table; idempotent release; the error sanitised before
   publish and before logging; cleanup never precedes the settled delivery
   attempt; `finally` around both `/new` acknowledgements so a rejected send
   cannot skip it; no retry loop.

4. `cache-bug-T4` — The desired-state settings contract. `user_facing:
   false`. Depends on T2 (the key must exist before its contract is typed).
   Serves the API half of S4.

   The new key changes the public payload of `/v1/settings/desired-state`,
   and that surface is currently untyped: the route accepts
   `settings?: unknown` and returns record-shaped JSON, and the OpenAPI
   registry documents `/v1/settings` but not `/v1/settings/desired-state`.
   T4 gives the endpoint a typed request and response DTO and registers it in
   the OpenAPI registry, satisfying `constitution/pnp-api-standards.md` and
   the swagger documentation standard. The PUT/GET round trip in the Verify
   Plan proves the field survives the surface; the DTO and registry entry are
   what make the contract checkable rather than incidental.

   Separated from T2 deliberately: this is a public HTTP contract with its
   own canon requirements, and folding it into the ceiling task is the
   over-stuffing that two plan grills have already flagged.

   Write scope: `apps/core/src/control/server/routes/settings.ts`, the
   OpenAPI registry, the contracts package DTO, tests.
   reviewer_focus: typed request AND response, no `unknown` at the boundary;
   the registry entry matches the implementation; no behaviour change to the
   settings pipeline T2 built.

Tasks run SEQUENTIALLY — T1 -> T2 -> T3 -> T4 — and each runs in its OWN task
branch and sibling worktree cut by `./forge task start <id>`, merging before
the next begins (WORKFLOW.md, AGENTS.md: per-task PRs are the standard). An
earlier draft said "sequential in one story worktree", which contradicted that
lifecycle and would have bypassed the per-task PR boundary. The order is a
dependency chain, not a preference: T3 needs the event types and cleanup drain
T2 introduces, and T4 types a settings contract whose key T2 adds. Each task
traces to criteria above; no task exists for later.

## Risks

- `contextUsage` absent on some runs (DeepAgents error path, an SDK without
  `getContextUsage`): the derived fallback covers it; over-approximation
  only retires sooner.
- Fence regressions: the null-safe `reset_at` comparison is new SQL; covered
  by the null/null and null/non-null repository tests (R1).
- Reader-version bump: fleet workers on version 15 hold their revision and
  alert until upgraded; documented in the operator procedure.
- Orphaned DeepAgents rows on process loss between commit and release, and
  from the uncovered paths: accepted (0159); operator scan documented.
- Lint debt exposed by adding a lint gate to verify at all: T1 fixes what its
  diff touches; the 82 pre-existing errors outside the diff are recorded as a
  deferral with a trigger, not silently fixed, baselined or suppressed.
- Recurring finding class `plan-contract-partial` touches repository
  contracts: tripwire — if review flags it on T1, escalate per WORKFLOW.md
  Recurring Findings rather than patching.

## Verify Plan

- `python3 factory/scripts/verify.py` after each task (never bypassed);
  from T1 on it includes `npm run lint:changed`.
- T2: a control-API round trip over `/v1/settings/desired-state` — PUT a
  document carrying `limits.provider_session_max_input_tokens`, GET it back,
  and assert the value survives the public surface. The parser and exporter
  tests cover the internals; only this proves the field is actually reachable
  through the API whose payload shape it changes.
- T1: `npm run db:migrations:check` clean; repository Postgres tests against
  `GANTRY_TEST_DATABASE_URL` (raise, retire, resetScope references, R1
  fences); unit tests for derivation, registry validation, normaliser route,
  both runners' error frames.
- T2: settings parser, defaults, revision-document, export and reader-hold
  tests; `group-processing.test.ts` additions for preflight, post-run raise,
  lost race; the four pinned tests untouched (diff shows no change); event
  publish, query and projection tests; a Postgres test executing the docs
  recipe.
- T3: `deepagents-checkpoint.postgres.integration.test.ts` additions for the
  four paths, idempotency, failure, lost transition, post-reply timing; both
  `/new` handler tests.
- Story close: `./forge review <id>` per task (one three-lens autoreview),
  `./forge task pr-ready <id>` per task, CI green; each runtime-behaviour PR
  carries its agent-e2e delta or states why not; deferrals recorded with
  `./forge defer add`.
