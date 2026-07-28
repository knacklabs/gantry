# MyClaw Response-Latency Program Roadmap

Status: source roadmap for bounded Forge tasks; not a per-task implementation plan
Validated against: `db41baa550a5779f119bf2cfa1b9890856afc69d` (`origin/main`, 2026-07-27)
Node evidence: `v25.2.1`
Primary metric: inbound message received to first content-bearing channel delivery

This roadmap reconciles the archived latency branch with the current accepted
decision corpus. Each optimization still needs its own worktree, Forge intake,
signoff, grilled and approved plan, decomposition, implementation, tests,
deterministic verify, one autoreview pass, and CI before merge. Runtime-behavior
PRs also need the checkout-bound KnackLabs runtime smoke before merge.

## Current-State Reconciliation

- Both `docs/decisions/0021-capability-artifacts.md` and
  `docs/decisions/0066-race-1-skill-artifact-app-isolation.md` are accepted,
  so Phase 6 has a live decision-reconciliation requirement rather than a
  simple "supersede 0021" prerequisite.
- Current code reflects Decision 0066's main contract: app/content-addressed
  skill artifact refs, length-prefixed bundle hashing, read-time hash
  verification in selected-skill projection, and storage refs keyed as
  `apps/<appId>/skills/<catalogId>/<contentHash>/`.
- Therefore the old Phase 6 cannot be replayed as "build immutable
  app-scoped refs and hash verification." That is delivered by the RACE-1 lane.
- Remaining Phase 6 work is measurement-gated: selected-skill read-cache
  behavior, single-object versus current per-asset layout decision
  reconciliation, bounded selected-skill materialization concurrency,
  fleet/IAM writer authority, side-effect-free readiness, and local-storage
  fail-closed runtime behavior.
- The archived two-file Phase 0 port proved only generic primitives,
  warm/new-session first-visible fixture behavior, and ten-instance isolation.
  That is insufficient for the user-supplied Phase 0 measurement contract.
  The fresh LAT-0 plan therefore expands Phase 0 to deliver deterministic
  the exact S1-S12 scenario harness support, named operation counters,
  boundary delay injection, bounded concurrency barriers, and a separate
  explicitly Postgres-gated query-counting helper while keeping production
  behavior unchanged. S11/S12 are current deterministic baselines over existing
  large-cardinality behavior/tests because their production fixes already
  exist.
- Job-list batching and IPC replay cleanup remain closed by shipped current
  code and regression evidence. Do not recreate a stale hot-path phase for
  them without a new measured contradiction.
- Current validation keeps Phases 1, 2, 3B, 4A, 5, and 7 directionally valid
  after rebaseline. Phase 3A needs a fence redesign before implementation.
  Phase 6 is obsolete as written and must honor accepted Decision 0066. Phase
  8 is closed, and Phase 9 remains measurement-gated.

## Program Acceptance

1. Every phase is a separate bounded Forge task, branch, reviewed commit set,
   PR, and CI run. Runtime-behavior phases also include a runtime-smoke
   package.
2. Every Phase 1+ optimization reports parent-commit baseline and PR-commit
   after evidence from the same scenario code.
3. Baseline evidence includes operation counts and first-content-bearing
   timing. Source inspection alone is not a performance claim.
4. Durable message, admission, cursor, session, memory, access, audit,
   credential, replay/signature, authorization, cancellation, provider-account,
   and app/skill isolation boundaries are preserved.
5. Replaced duplicate code is deleted in the same phase after parity proof.
6. Postgres-backed changes run the disposable Postgres lane. Missing
   `GANTRY_TEST_DATABASE_URL` is a blocker, not a pass.
7. Runtime PRs run the checkout-bound KnackLabs lead-maintenance smoke before
   merge.

## Phase Roadmap

### Phase 0 - Shared Response-Latency Harness Foundation

Branch: `perf/response-latency-baseline`

Add test-only primitives and scenario support for deterministic manual time,
operation counters, boundary delay injection, bounded concurrency barriers, a
provider-neutral scripted fake streaming model, a settlement-aware fake channel,
the first-content metric, exact S1-S12 scenario fixtures/contracts, and a
separate Postgres-gated query-counting helper.

Phase 0 may split into bounded stages/commits inside one PR:

1. primitives and first-content contract;
2. S1-S12 scenario fixture contracts;
3. Postgres-gated query counting and integration support.

Non-goal: no production tracing, cache, prewarm, real provider calls, real S3
network dependency, real remote MCP network dependency, or production runtime
behavior change. Later phase PRs may add phase-specific before/after assertions
using these fixtures.

### Phase 1 - Bounded Concurrent Remote MCP Startup

Branch: `perf/parallel-inline-mcp-startup`

Connect and discover remote MCP servers with a small local concurrency limit,
preserving deterministic server/tool order, guarded fetch, headers, abort
handling, host denylist behavior, and exact cleanup of connected clients.

### Phase 2 - One Immutable Per-Turn Access Snapshot

Branch: `perf/agent-access-snapshot`

Load active tool bindings, enabled skills, and materialized MCP server rows
once per turn, then derive tool policy, selected-skill displays, skill actions,
semantic capability context, capability catalog, and access fingerprint through
pure value-equivalent projections.

### Phase 3A - Single Memory Hydration

Branch: `perf/single-memory-hydration`

Needs fence redesign before implementation. Keep admission non-hydrating, but
do not assume the old expected session/reset fence is sufficient. The phase plan
must re-resolve the current runner/admission/session paths and design the exact
final-turn context fence that permits one memory hydration without losing reset,
promotion, compaction, or resumed-session correctness.

### Phase 3B - Cursor-Fenced Pending Replay Reuse

Branch: `perf/cursor-fenced-replay`

Reuse a preloaded pending replay only when cursor, queue identity,
conversation/thread/provider scope, replay ids, and replay cursor are
internally consistent. Mismatch falls back to the authoritative load.

### Phase 4A - One Inbound Envelope Transaction

Branch: `perf/inbound-envelope-persistence`

Persist normalized metadata, one message, and all eligible admissions in one
serialized transaction, then notify new admissions after commit. Stable graph
upsert deletion is out of scope unless after-measurement earns a separate
decision and PR.

### Phase 5 - Durable Provider-History Coverage

Branch: `perf/provider-history-watermark`

Requires a new accepted decision before implementation. Durable coverage must
be scoped by app, provider account, conversation, exact thread scope, provider
generation, coverage cursor, bounded-window completeness, thread-root coverage,
and an expiring claim. Provider API coverage must be recorded as actual
coverage, not inferred from local row count.

### Phase 6 - Skill Artifact Read-Path And Fleet Readiness Remainder

Branch: to be decided after measurement and decision reconciliation

Delivered by Decision 0066/current code:

- app/content-addressed immutable storage refs;
- unambiguous length-prefixed hash framing;
- read-time hash verification for selected-skill projection;
- app-scoped install lock keys;
- no generic new storage abstraction.

Remaining candidate scope:

- measure selected-skill S3/local-cache operation counts on current code;
- reconcile accepted Decisions 0021 and 0066 before implementation;
- decide whether a single-object bundle is still worth replacing the current
  Decision 0066 per-asset content-addressed layout;
- prove cache hit zero remote reads and miss behavior against exact
  `appId/catalogId/contentHash` identity, or record why current behavior is
  acceptable;
- bound selected-skill materialization concurrency if measurement shows it is
  material;
- verify fleet IAM writer/read-only ownership and deployment canary behavior;
- enforce or document fail-closed fleet startup for local skill storage and
  side-effect-free exact-key readiness.

Do not absorb general `FileArtifact` bytes into this phase; that remains ART-1
or a separately approved storage task.

### Phase 7 - Direct In-Process Model Forwarding

Branch: `perf/direct-llm-forwarder`

Requires the accepted SPS/direct-forwarding decision before implementation.
Extract one forwarding application operation for route confinement, credential
injection/revocation, approved headers, upstream timeout, cancellation,
streaming, usage/audit, and error normalization. Preserve Decision 0046's
process-local admission-before-body-read behavior unless superseded.

### Closed/Measurement-Gated Items

- Job latest-run batching: closed by shipped batch projection and regression
  coverage.
- IPC replay cleanup: closed by shipped bounded cleanup and regression
  coverage.
- Warm reusable resources: unscheduled. Reopen only if post-Phase-7 evidence
  shows repeated deterministic local construction remains material and a new
  accepted decision scopes the authority fences.

## Decisions Required Later

- Phase 5 durable provider-history coverage ownership, generation
  invalidation, and claim semantics.
- Phase 6 decision reconciliation if replacing the current Decision 0066
  per-asset layout with a single-object bundle, adding migration readers, or
  changing IAM/readiness authority.
- Phase 7 direct model-forwarding boundary.
- Any reusable warm-resource proposal after measurement.

## Verification Doctrine

Before each phase:

```bash
./forge next
./forge decision list --active
./forge findings patterns
./forge context list --pending
./forge lesson relevant --files <expected write scope>
```

Before review, select the smallest relevant gates plus the repository release
gates:

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

Every runtime PR additionally proves the active checkout is the installed
runtime and then runs:

```bash
scripts/agent-job-smoke.sh job-knacklabs-lead-maintenance-43527c192a6e --timeout-sec 900
```
