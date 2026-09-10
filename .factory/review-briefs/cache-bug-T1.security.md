# Review brief — cache-bug-T1 — security lens

You are one lens of a three-lens code review. You see ONLY the diff bundle for
this task (no repository access), so judge what the diff shows and say so when
something cannot be verified from it. Report every finding with its
file_path and line. Use ONLY these categories: bug, security, regression,
test_gap, maintainability. Priorities: P0/P1 block the task; P2/P3 must be
resolved or explicitly deferred with a reason before it ships.

LENS: SECURITY. OWASP-style trust boundaries, authentication and authorization
(every new route/handler: who may call it, with what scope), secrets and
credential handling, injection (SQL/command/template), data exposure and
over-broad responses, unsafe defaults, privilege escalation, and abuse paths.
Use category `security` for these findings.

LEFTOVERS (blocking): the diff must carry no code kept only for compatibility — no wrapper or shim over its replacement, no re-export or alias kept 'for callers', no renamed-but-retained symbol, no dead branch behind a removed feature, no 'legacy'/'deprecated'/'backward' naming or comment. Report each as a BLOCKING finding with file:line and verdict the contract it belongs to as partial; a clean diff says so in one line.
## Task cache-bug-T1

### Plan contracts

- **T1-AC1**
  - Source: plans/active/cache-bug-bound-provider-session-context-growth-across-runner-restarts.md#technical-approach
  - Statement: S1 derivation: modelVisibleInputTokens returns 271,500 for an Anthropic usage of 1,000 input / 270,000 cache read / 500 cache write; 1,000 for an OpenAI-compatible usage of 1,000 input / 800 cached; the additive form for a mixed or unresolved route; totalBillableInputTokens and all other billing fields unchanged; the route resolves from usage.modelRoute and falls back to usage.provider when modelRoute is absent (provider fallback).
- **T1-AC2**
  - Source: plans/active/cache-bug-bound-provider-session-context-growth-across-runner-restarts.md#technical-approach
  - Statement: S2/R2 partial usage, spawned runners: an errored Claude worker run and an errored DeepAgents worker run each write one cumulative partial-usage payload with the turn's usageEventId on their single error frame; Claude carries it as a typed QueryFailure thrown from the result branch and written by runner/index.ts; DeepAgents carries it as a typed DeepAgentPartialUsage value passed stream-normalizer → deep-agent-runner → index.
- **T1-AC3**
  - Source: plans/active/cache-bug-bound-provider-session-context-growth-across-runner-restarts.md#technical-approach
  - Statement: S2/R2 partial usage, inline lanes: an errored Claude inline-lane turn and an errored DeepAgents inline-lane turn each emit one terminal error output carrying the accumulated usage with the turn's usageEventId.
- **T1-AC4**
  - Source: plans/active/cache-bug-bound-provider-session-context-growth-across-runner-restarts.md#technical-approach
  - Statement: S3 storage: provider_sessions.context_high_water_mark is a nullable integer column added by a generated drizzle migration (db:migrations:check clean); raiseProviderSessionContextHighWaterMark keeps the larger value, leaves metadata_json untouched, rejects a stale owner, ignores non-resumable rows, rejects non-integer or negative values before SQL with ProviderSessionMeasurementError, and returns whether a row changed; the turn-context projection returns contextHighWaterMark.
- **T1-AC5**
  - Source: plans/active/cache-bug-bound-provider-session-context-growth-across-runner-restarts.md#technical-approach
  - Statement: R1 fences: raise and retireProviderSession compare agent_sessions.reset_at with IS NOT DISTINCT FROM the caller's generation; a null/null generation succeeds and null versus non-null is rejected on both operations.
- **T1-AC6**
  - Source: plans/active/cache-bug-bound-provider-session-context-growth-across-runner-restarts.md#technical-approach
  - Statement: R1 retirement: retireProviderSession is one atomic active→expired UPDATE fenced on id, agent_session_id, provider, external_session_id, status='active' and the generation, returning { providerSessionId, externalSessionId, executionProviderId } or undefined; the fingerprint-change, missing-session and ops-service facade callers switch to it, while the compaction-delta degradation path keeps the existing expireProviderSession helper unchanged (0159 §4).
- **T1-AC7**
  - Source: plans/active/cache-bug-bound-provider-session-context-growth-across-runner-restarts.md#technical-approach
  - Statement: R3 registry: every executable route's cacheSupport.prompt declares cacheReadsIncludedInInput and cacheWritesIncludedInInput (type in model-provider-registry.ts); the registry validator fails a route missing either; nonzero OpenAI and OpenRouter cache-write usage yields inputTokens unchanged; DeepAgents normalised usage carries the resolved provider and modelRoute.
- **T1-AC8**
  - Source: plans/active/cache-bug-bound-provider-session-context-growth-across-runner-restarts.md#technical-approach
  - Statement: R4 return type: resetScope returns an immutable list of retired { providerSessionId, externalSessionId, executionProviderId } selected FOR UPDATE before delete and returned after commit, and a readonly empty list on no-route or empty paths; canonical-session-ops-service, canonical-ops-repo.postgres.ts and clearSessionForChatJid propagate it; no caller releases yet.
- **T1-AC9**
  - Source: plans/active/cache-bug-bound-provider-session-context-growth-across-runner-restarts.md#technical-approach
  - Statement: S11 lint gate: a package.json script lint:changed (ESLint over the TypeScript files changed against the merge-base with origin/main) runs inside FACTORY_STRUCTURAL_CMD in .envrc and as the blocking CI check step; full npm run lint stays an advisory continue-on-error CI step; every file this task touches is lint-clean; the 82 pre-existing errors outside the diff are recorded as deferral D-0080 with a trigger and are neither fixed, baselined nor suppressed here.
- **T1-AC10**
  - Source: plans/active/cache-bug-bound-provider-session-context-growth-across-runner-restarts.md#technical-approach
  - Statement: S10 unchanged behaviour: the four pinned tests (group-processing 'passes hydrated memory context with provider session resume id', agent-runner-ipc 'resumes and persists SDK sessions for live channel turns', claude-agent-sdk-boundary 'passes hermetic Gantry capabilities and settings into the Claude SDK', deepagents-memory-context 'injects the trust-scoped memory block exactly once as a model-visible user message') and the scheduled-job tests are untouched and green; python3 factory/scripts/verify.py is green.

### Reviewer focus

Load-bearing constitution references: pnp-coding-standards-modular-monolith.md (domain error types, no bare Error; typed constants over string literals; mappers separate from data access) and 03-modular-monolith-structure.md (adapter-owned provider knowledge stays in adapters; domain/repositories owns the port). Task-specific seam: the two new repository operations are single SQL statements whose predicates are the whole safety story — the null-safe reset_at fence must appear in BOTH raise and retire, and retire must be the only path that flips active→expired and must RETURN the row it flipped; the compaction-delta degradation path is deliberately left on the old expire helper (ready row) and must not be 'cleaned up' into retire. Concerns that must not share a file: measurement value validation and its domain error (domain/sessions), the SQL (repository helpers), the derivation (shared/model-usage), the registry booleans and their validator (provider registry). Partial-usage carriers are typed value objects: DeepAgents threads DeepAgentPartialUsage through three runner files; Claude throws a typed QueryFailure that runner/index.ts unwraps into exactly one error frame — never two frames, never ad-hoc fields on Error. Inline lanes mirror the same shape in their own modules. resetScope's return is readonly and never undefined. The migration is generated by drizzle-kit and committed as emitted. Deferred to T2 with TODO(T2): reading the mark for policy and raising it after runs — T1 only exposes the operations and the projection; deferred to T3: consuming the retired references.

### Settled — do not relitigate

The following are accepted: the story plan's decisions and rulings, and the contracts of tasks already sealed in this story. A finding that contradicts one is a proposal to change a decision, which belongs in a decision record, not in this review; do not raise it as a defect. Rejected findings from earlier rounds are ledgered as lessons below.

#### Story plan — Decisions

- `docs/decisions/0158-provider-session-context-ceiling.md` (accepted) — the
  ceiling rule, metric preference, typed column, global setting, no data
  migration.
- `docs/decisions/0159-adapter-session-release-port.md` (accepted) —
  provider-neutral release port, `/new` returning references, covered and
  uncovered paths including the compaction-delta degradation path.

Tooling: no new packages. Drizzle migrations via `db:migrations:generate`,
Vitest for unit and Postgres integration tests, the existing
`deepagents-checkpoint.postgres.integration.test.ts` harness, ESLint already
configured — all installed and the only fit for this repo.

### Lessons in force

Recorded lessons that apply to this task's paths. A finding that contradicts one is not a defect unless it shows the lesson itself is wrong; say so explicitly instead of re-raising it.

- [medium] schema storage: Runtime state, jobs, control events, and memory use Postgres as the production storage model; schema or repository changes need repository tests and architecture/docs updates when contracts shift.
- [high] canonical-postgres-cutover: When replacing Postgres runtime schema in one cut, move active runtime persistence behind canonical Drizzle repositories/services in the same change; leaving schema-owned raw SQL or old table definitions creates drift and runtime failures after destructive migrations.
- [high] architecture boundaries: Keep provider-specific and channel-specific behavior behind adapters; domain and application code should depend on stable product concepts and ports, not SDK payloads or runtime wiring.
- [high] permission safety: Risky tool execution must pass through deterministic permission evaluation and sandbox policy before any provider callback or runner grants access.
- [medium] fleet-compose-rehearsal: Fleet compose rehearsal must run settings-seed through the normal Docker entrypoint so local auto-secrets are exported, and seed desired-state via the import service rather than the broad CLI bootstrap; the CLI bootstrap can close the shared runtime storage pool before settings import validation finishes. Docker-internal first-party Postgres hostnames need explicit plaintext allowance while real remote Postgres still requires sslmode=require.
- [high] runner-sandbox-copy-lists: Runner-spawning tests (agent-runner-ipc, ipc-mcp-stdio) sandbox the runner by COPYING source files; hand-enumerated lists silently break when a new module becomes runner-reachable (every test then burns its ~19s IPC timeout). Fixed 2026-07-22 by recursive cpSync of the whole shared/ tree. If a runner-spawn test suite suddenly times out uniformly, check the sandbox copy set FIRST; never reintroduce per-file enumeration of a derivable file set.
- [high] JSONB persistence vs in-memory fakes: Postgres JSONB normalizes object key order and drops undefined; any equality check against persisted state (JSON.stringify ===) silently fails in prod while structuredClone-based fakes keep it green. Compare with util.isDeepStrictEqual and make repository fakes persist through a JSONB-faithful round trip (see test/unit/application/jsonb-round-trip.ts).
- [high] t3a-implementation-order: T3a order that fits one Codex run: (1) schema.ts + port + repository + domain/types.ts + the shared boundary canonicalPath, then run npm run db:migrations:generate -- --name permission_decision_memory_human (NEVER hand-write the SQL or snapshot; commit what drizzle-kit emits), then npx tsc --noEmit; (2) the scope-key module and the service; (3) tests ONE FILE AT A TIME in this order — provenance, scope, service, prospective-write pin, Postgres suite — running each file right after writing it and never re-reading a finished source file. Postgres tests need the TEST database: run 'source /private/tmp/claude-501/-Users-ravikiranvemula-Workdir-myclaw/b4051e43-dbea-4d62-ba73-ae6210455474/scratchpad/pgfix-env.sh' in the same shell before vitest (it exports GANTRY_TEST_DATABASE_URL for gantry_test; the live database gantry must never be touched). Required leaf titles are exact it() names from the brief.
- [high] lint gate is diff-scoped until deferral D-0080 fires: cache-bug-T1 AC9/S11 is fulfilled by npm run lint:changed (ESLint over TypeScript files changed against the merge-base with origin/main) inside FACTORY_STRUCTURAL_CMD in .envrc and as the blocking CI step, with full npm run lint kept as an advisory continue-on-error CI step; the 82 pre-existing errors are recorded as deferral D-0080 and must NOT be fixed, baselined or suppressed in this task. This is the orchestrator's recorded ruling (signals S-0092, S-0095, S-0099, 2026-09-09): do not raise it again.
- [high] cache-bug-T1: partial-usage wrapper must not swallow close-driven aborts: apps/core/test/integration/deepagents-langchain-boundary.postgres.integration.test.ts 'aborts an in-flight run on a _close sentinel and exits cleanly with NO completed marker (close-stdin)' fails deterministically (exit code 1, error frame) because stream-normalizer-partial-usage.ts wraps EVERY thrown error into the DeepAgentPartialUsage carrier, so runner/index.ts:283 (liveControl.closed() && isAbortError(err)) no longer recognises the close-driven AbortError as a graceful stop. Fix: the wrapper passes abort errors through unwrapped (isAbortError check before wrapping), or isAbortError looks through the carrier's cause; keep the partial-usage frame for genuine failures. Run the DB-gated integration lane (npm run test:integration with GANTRY_TEST_DATABASE_URL) on Node 24 before reporting.
