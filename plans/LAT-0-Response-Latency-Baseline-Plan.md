# LAT-0 Response Latency Baseline Plan

## Problem

MyClaw has confirmed response-latency hotspots in the inbound-message to
first-content-bearing-output path, but the program must not optimize or claim
latency wins from source inspection alone. LAT-0 must provide the deterministic
Phase 0 measurement contract the user requested: reusable test-only primitives,
S1-S12 scenario harness support, named operation counters, boundary delay
injection, bounded concurrency barriers, and a separate Postgres-gated
query-counting helper.

This revision corrects the earlier draft, which incorrectly narrowed LAT-0 to
the archived 17-test primitive harness. That old port is useful evidence for
the primitives stage, but it does not satisfy the full Phase 0 measurement
contract.

Assumptions:

- Source roadmap: `plans/MyClaw-Response-Latency-Refactor-Plan.md`.
- Worktree base: `db41baa550a5779f119bf2cfa1b9890856afc69d`.
- Node 25 evidence: `v25.2.1`.
- `@session-state.md` is ignored local coordination state.
- Phase 0 is test-only and keeps production behavior unchanged.
- Later phase PRs may add phase-specific before/after assertions using the
  LAT-0 fixtures, but LAT-0 owns the reusable scenario matrix/counter support
  and current deterministic baselines for S11/S12 using existing
  large-cardinality behavior/tests.

## Scope / Non-goals

Scope:

- Add reusable test-only helpers for deterministic manual time, first
  content-bearing delivery, explicit boundary delays, operation counters, and
  bounded concurrency barriers.
- Add a provider-neutral scripted fake streaming model and fake channel probe
  that distinguish control/progress/session frames from content-bearing output.
- Add all named operation counters from the source contract:
  `postgres_statements`, `postgres_transactions`, `get_messages_since_calls`,
  `provider_history_calls`, `memory_hydrate_calls`,
  `list_enabled_skills_calls`, `get_skill_calls`, `list_tool_bindings_calls`,
  `get_tool_calls`, `list_mcp_bindings_calls`, `get_mcp_server_calls`,
  `s3_list_calls`, `s3_get_calls`, `mcp_connect_calls`, and
  `mcp_list_tools_calls`.
- Add boundary delay injection points for ingress receipt, metadata
  persistence, message commit, admission notification, replay load,
  conversation local load, provider history hydration, provider-history
  persistence, provisional/final session context, memory hydration, access row
  load/projection, skill artifact projection, MCP materialization,
  MCP connect/discovery, adapter prepare, provider first byte, and channel
  first visible delivery.
- Add deterministic S1-S12 scenario fixture contracts using the user's exact
  scenario IDs:
  - S1 warm top-level/no thread/no skill/no MCP/new session;
  - S2 sparse top-level provider history;
  - S3 sparse thread root plus tail;
  - S4 resumed provider session plus memory;
  - S5 ten enabled skills, three selected skills, local store;
  - S6 same delayed S3-like store;
  - S7 three MCP servers delayed 100/200/300 ms;
  - S8 one message to three agents;
  - S9 ten independent conversations;
  - S10 direct LLM streaming with a 1 MiB request;
  - S11 500 jobs;
  - S12 IPC 5,000 markers.
- Record S11/S12 current deterministic baselines using existing
  large-cardinality behavior/tests because their production fixes already
  exist.
- Add explicitly Postgres-gated query counting/integration support as a
  separate helper/gate, not as S12. It must run only in the disposable Postgres
  lane and treat missing `GANTRY_TEST_DATABASE_URL` as blocked evidence, not a
  pass.
- Keep diagnostics and evidence payloads count/timing/status/boolean-only.

Non-goals:

- No production behavior change.
- No production tracing framework, cache, prewarm, global singleton, or remote
  service.
- No real provider calls, real S3 network dependency, or real remote MCP
  network dependency in deterministic unit scenarios.
- No persistent developer data in LAT-0 tests.
- No Phase 1+ optimization or before/after performance claim.
- No changes to durable message, admission, cursor, session, memory, access,
  audit, credential, replay/signature, authorization, cancellation, provider,
  app, or skill-storage authority boundaries.

## Acceptance Criteria

- `LAT-0` provides deterministic reusable harness primitives and S1-S12
  scenario fixture support for later baseline/after tests.
- First-visible timing captures a pending candidate timestamp exactly when the
  first content-bearing part or chunk reaches the fake channel.
- Settlement publishes that candidate only when a completed send succeeds or
  when a `delivery_incomplete` settlement proves at least one content-bearing
  part or chunk reached the channel.
- The harness trims whitespace and ignores session-init, runtime-event,
  progress, terminal-null, typing, usage, empty, and whitespace-only frames.
- It discards the candidate for `not_delivered`, rejected sends, or partial
  attempts with no delivered content-bearing part.
- Delay injection is explicit at the named boundaries in this plan and can be
  advanced under test control.
- Operation counters expose all named operation counters in this plan and allow
  generic string counters for future phase-local additions without API changes.
- Barrier helpers deterministically prove all expected work arrived and report
  observed maximum active count without relying on elapsed time as the merge
  gate.
- The provider-neutral scripted fake streaming model emits configured
  non-content frames and one content-bearing frame after a controlled delay and
  never calls a real provider.
- The fake channel delivery probe records attempted deliveries and settlements.
- The S1-S10 fixture contracts emit first-content timing plus
  operation-counter snapshots.
- S11 records the current deterministic 500-job baseline using existing
  large-cardinality behavior/tests.
- S12 records the current deterministic IPC 5,000-marker baseline using
  existing large-cardinality behavior/tests.
- A separate disposable-Postgres integration helper records statement and
  transaction counts. It is explicitly skipped only by the repository's
  Postgres-lane gating rules and is blocked, not green, when a Postgres-backed
  claim is required but `GANTRY_TEST_DATABASE_URL` is missing.
- Ten independent harness instances do not share clock, counters, barriers,
  deliveries, scenario state, or first-content observations.
- Diagnostics and evidence payloads contain only identifiers, counts,
  durations, statuses, and booleans. They do not contain prompts, message text,
  schemas, credentials, secret-bearing URLs, or tool arguments.
- Existing production and test behavior outside the new LAT-0 harness/tests
  remains unchanged.
- The decomposition records `user_facing: false`.

## Technical Approach

Recommendation: implement Phase 0 as three bounded test-only stages in one PR.
This satisfies the user's full measurement contract without touching production
runtime behavior.

Expected test-only write scope:

- `apps/core/test/harness/response-latency-harness.ts`
- `apps/core/test/harness/response-latency-scenarios.ts`
- `apps/core/test/harness/response-latency-postgres.ts`
- `apps/core/test/unit/runtime/response-latency-contract.test.ts`
- `apps/core/test/unit/runtime/response-latency-scenarios.test.ts`
- `apps/core/test/integration/response-latency-postgres.postgres.integration.test.ts`

Stage 1 primitives:

- deterministic manual clock with `nowMs`, `advanceMs`, and marker recording;
- named and generic operation counters with immutable snapshots;
- boundary delay controls keyed by stable boundary names;
- bounded concurrency barriers with all-arrived and max-active observations;
- provider-neutral scripted fake streaming model;
- settlement-aware first-content delivery probe;
- small content predicate helpers.

Stage 2 scenario fixtures:

- S1-S10 scenario builders that share the same primitive harness and emit
  first-content metrics plus counter snapshots;
- deterministic fake dependencies for provider history, memory hydration,
  access rows, selected-skill artifacts, remote MCP connect/list-tools,
  inbound multi-route admission, and direct LLM streaming;
- no real provider/S3/MCP network calls in unit scenarios.

Stage 3 Postgres/query counting:

- a Postgres-gated integration fixture that runs only through the disposable
  Postgres lane;
- query/transaction counting as a separate integration helper and reusable
  support for later Postgres-backed phases;
- explicit blocked reporting when Postgres-backed evidence is required but
  `GANTRY_TEST_DATABASE_URL` is unavailable.

Rejected narrower approach:

- The archived 17-test primitive harness is not enough. It omits S1-S12 and
  real Postgres query-counting support, so it would not satisfy the user's
  Phase 0 measurement contract.

Rejected broader approach:

- Production tracing or optimization hooks are still too broad for LAT-0.
  Phase 0 should provide deterministic test support; later phase PRs use that
  support for before/after optimization evidence.

## Decisions

- `docs/decisions/0069-client-signoff.md` records the accepted LAT-0 client
  signoff for the full Phase 0 measurement harness contract.
- No new technical decisions. LAT-0 adds no durable data model, public API,
  production setting, runtime authority boundary, library dependency, or
  runtime behavior.
- Later Phase 6 planning must reconcile accepted Decisions 0021 and 0066 before
  changing skill artifact layout, cache, IAM, or readiness behavior.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Unchanged by design | LAT-0 is test-only and does not wire production timing, caching, prewarm, or optimization behavior. |
| API | Unchanged by design | No public route, SDK, provider, or channel contract changes. |
| Data/schema | Unchanged by design | No migrations, tables, repository writes, or durable state changes. |
| CLI/ops | Read-only | Existing verification commands and Postgres lane are used; no CLI/settings change. |
| UI | N-A | No user-facing UI or channel presentation change. |
| Docs | Changed | Adds the program roadmap, LAT-0 plan draft, and signoff decision. |
| Tests | Changed | Adds test-only harness, scenario contract tests, and a Postgres-gated query-counting integration scenario. |

## Task Decomposition

Stage `LAT-0-PRIMITIVES`

- Objective: create the deterministic primitive harness used by every LAT-0
  scenario.
- Write scope:
  - `apps/core/test/harness/response-latency-harness.ts`
  - `apps/core/test/unit/runtime/response-latency-contract.test.ts`
- Dependencies: none.
- Required tests: manual clock, named/generic counters, boundary delays,
  scripted fake streaming model, fake channel first-content semantics,
  completed send, qualifying partial delivery, non-qualifying partial delivery,
  not-delivered, rejected send, retry timestamp stability, barrier
  all-arrived/max-active behavior, and ten-instance isolation.
- Reviewer focus: false first-content positives, shared mutable state,
  wall-clock-only assertions, and diagnostic content leaks.

Stage `LAT-0-SCENARIOS`

- Objective: add deterministic S1-S12 scenario fixture contracts on top of the
  primitives.
- Write scope:
  - `apps/core/test/harness/response-latency-scenarios.ts`
  - `apps/core/test/unit/runtime/response-latency-scenarios.test.ts`
- Dependencies:
  - `LAT-0-PRIMITIVES`
- Required tests: S1-S10 fixture contracts emit first-content timing, named
  operation-counter snapshots, and controlled boundary delays without real
  provider/S3/MCP network calls. S11/S12 record current deterministic baselines
  using existing large-cardinality behavior/tests for 500 jobs and IPC 5,000
  markers.
- Reviewer focus: scenario names matching the source contract, no hidden
  production dependencies, no phase-specific optimization assertions, and no
  omitted operation counters.

Stage `LAT-0-POSTGRES`

- Objective: add the disposable-Postgres query-counting integration support
  for later Postgres-backed phase baselines as a separate helper/gate, not as
  S12.
- Write scope:
  - `apps/core/test/harness/response-latency-postgres.ts`
  - `apps/core/test/integration/response-latency-postgres.postgres.integration.test.ts`
- Dependencies:
  - `LAT-0-PRIMITIVES`
  - `LAT-0-SCENARIOS`
- Required tests: Postgres statement count, transaction count, cleanup between
  runs, no persistent developer data, and explicit blocked handling when
  Postgres evidence is required but `GANTRY_TEST_DATABASE_URL` is unavailable.
- Reviewer focus: disposable database isolation, no durable schema changes,
  accurate query/transaction counting, and blocked-versus-skipped reporting.

## Risks

- Phase 0 can bloat into production tracing. Mitigation: keep all writes under
  `apps/core/test/` and leave production runtime unchanged.
- Scenario fixtures can overfit future implementation choices. Mitigation:
  model boundaries and counters, not optimized behavior.
- A fake visibility predicate can count control frames. Mitigation: explicit
  negative-frame unit tests.
- Timing assertions can become flaky. Mitigation: barriers are the merge gate;
  elapsed time is supplemental only.
- Postgres query counting can be mistaken for a green default test run.
  Mitigation: keep query counting in its separate disposable Postgres helper
  and report missing `GANTRY_TEST_DATABASE_URL` as blocked when Postgres
  evidence is required.
- Runtime smoke can use another checkout if service installation is stale.
  Mitigation: runtime-behavior PRs must prove the installed service points at
  the active checkout before running smoke; LAT-0 itself is test-only.

## Verify Plan

Planning verification already run:

```bash
./forge next
./forge decision list --active
./forge findings patterns
./forge context list --pending
./forge defer list --open
./forge lesson relevant --files apps/core/test/harness/response-latency-harness.ts apps/core/test/unit/runtime/response-latency-contract.test.ts plans/MyClaw-Response-Latency-Refactor-Plan.md
node --version
```

Targeted implementation checks:

```bash
npm run test:unit -- apps/core/test/unit/runtime/response-latency-contract.test.ts
npm run test:unit -- apps/core/test/unit/runtime/response-latency-scenarios.test.ts
npm run test:integration:postgres -- apps/core/test/integration/response-latency-postgres.postgres.integration.test.ts
```

Before review:

```bash
npm run format:check
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:integration:postgres
npm run test:e2e:agent:hermetic
npm run check:architecture
python3 .agents/scripts/verify.py
```

Closeout gates:

- signoff grill refreshed after this scope correction;
- plan grilled and saved after this scope correction;
- decomposition recorded with three stages and `user_facing: false`;
- automated tests recorded through the repository recorder;
- deterministic verify passes;
- one autoreview run records quality, performance, and security;
- `python3 .agents/scripts/pr_ready.py` passes;
- GitHub CI is green;
- checkout-bound KnackLabs lead-maintenance smoke is not required for LAT-0
  because it is test-only; runtime-behavior PRs in later phases must run it
  before merge.
