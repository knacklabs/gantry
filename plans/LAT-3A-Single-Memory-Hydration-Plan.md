# LAT-3A — Hydrate Agent Memory Exactly Once Per Inbound Turn

Issue: `LAT-3A`
Branch: `perf/phase3a-single-memory-hydration`
Base: `origin/main` @ `55ddfca7c`
Program: MyClaw Response-Latency Refactor, Phase 3A
Governing decision: `docs/decisions/0076-lat-3a-single-memory-hydration-per-turn.md`
Sign-off: `docs/decisions/0077-client-signoff.md`

## Problem

On the inbound interactive hot path, agent memory hydrates **twice** per turn.

Admission is already correct and load-bearing: it calls `getAgentTurnContext`
with an explicit `hydrateMemory: false` and no promotion
(`apps/core/src/app/bootstrap/live-execution.ts:224-232`). It resolves the
canonical app/session scope, ensures the agent session, releases stale
maintenance locks, and selects the latest resumable provider session
(`canonical-session-repository.postgres.ts:58-104`). It is not the problem and
does not change.

The waste is inside the runner. `loadTurnContext` omits `hydrateMemory`
(`apps/core/src/runtime/group-agent-runner.ts:140-156`), and the service gate is
`input.hydrateMemory === false ? undefined : hydrate(...)`
(`canonical-session-ops-service.ts:213-221`) — so **omission hydrates**. The
runner takes a provisional read at `:158`, then `prepareCompactionDeltaReplay`
takes a second read that also hydrates.

`prepareCompactionDeltaReplay` has four exit paths, and which read the model
actually sees differs per path:

| Path | Exit | Model-visible context | Hydrations before model | Total per turn | Wasted |
| --- | --- | --- | --- | --- | --- |
| maintenance session | `compaction-delta.ts:51-53` | provisional | 1 | 1 | 0 |
| ordinary, no pending delta | `:54-62` → `loadTurnContext(true)` | promoted read | 2 | 2 | 1 |
| delta too stale / too large | `:85-103` → `loadTurnContext(false)` | non-promoted read | 2 | 2 | 1 |
| pending delta replay | `:105-130` → `replayTurnContext` | **provisional** | 1 | 2 | 1 |

The pending-delta row is the subtle one: only **one** hydration happens before
the model call, but `markApplied` (`:113-128`) takes a second hydrating read
*after* output handling, so the turn still pays twice. That read is invoked from
`group-agent-runner.ts:684-701` — inside `runGroupAgent` — so it is inside AC1's
measurement window.

One hydration is not cheap: `HydrateAgentContextService.hydrate` fans out
across `agent_sessions`, `agent_session_digests`, `memory_items`,
`conversations`, `canonical_jobs`, and `control_http_sessions`
(`apps/core/src/application/sessions/hydrate-agent-context-service.ts:106-135`).

Two facts make this tractable, and both are load-bearing for the approach:

1. The return type has **exactly one** hydration-derived field,
   `memoryContextBlock?: string` (`canonical-session-ops-service.ts:191-192,224`).
   Every other field is repository-derived.
2. Promotion mutates provider-session rows only. It does not touch
   `memory_items` or `agent_session_digests`.

Nothing currently prevents regression: no test asserts the real runner's
per-turn hydration count. The merged Phase 0 harness owns a
`memory_hydrate_calls` counter (`apps/core/test/harness/response-latency-harness.ts:46-89`)
but its S4 scenario increments it through a **fake** seam
(`apps/core/test/harness/response-latency-scenarios.ts:185-217`), so the harness
as merged cannot falsify this phase's claim.

**Baseline reproduced before proposing any production change.** The problem
reproduces at `55ddfca7c` on three of four paths, so no Forge signal was
raised. The one correction needed is to the handover itself, not the phase: the
goal prompt's instruction to "hydrate exactly once against the final promoted
context" is wrong for the pending-delta path, where the model consumes the
provisional context. That is resolved in decision 0076 and corrected in
`docs/architecture/messaging-hotpath-and-liveness-goal-prompt.md`.

## Scope / Non-goals

### In scope

Two production files:

- `apps/core/src/runtime/group-agent-runner.ts` — `loadTurnContext` gains a
  hydration argument.
- `apps/core/src/runtime/group-agent-runner-compaction-delta.ts` — every later
  read becomes non-hydrating and takes the fenced memory carry.

Plus tests, and wiring `memory_hydrate_calls` to the real
`GroupProcessingRepository.getAgentTurnContext` seam.

### Non-goals

- The admission call's arguments or semantics (load-bearing, already correct).
- `HydrateAgentContextService`, the memory recall query, its scoring, or its
  250 ms `first_visible` lexical-only timeout.
- The scheduled-job hydrating call at `apps/core/src/jobs/execution.ts:324-335`
  — deferred as **D-0018** with a revisit trigger. A job is not an inbound turn
  and sits outside this program's primary metric.
- The non-hydrating control (`group-session-command-state.ts`), recovery
  (`live-recovery-coordinator.ts`), and inline-task
  (`inline-agent-task-lifecycle.ts`) callers — already correct.
- Carrying an expected session identity from admission into the runner. Named
  by the roadmap, **explicitly rejected** in decision 0076; see the Decisions section.
- Durable memory, session, admission, cursor, provider-account, or app
  isolation authority boundaries.
- Settings, schema, migrations, public API, SDK, CLI, permission surfaces.
- No cache, no warm pool, no cross-turn mutable state, no rollout flag.

## Acceptance Criteria

- **AC1** — On the ordinary inbound turn, `getAgentTurnContext` is called with
  a hydrating argument **exactly once** inside `runGroupAgent`. Asserted
  against the real repository seam, not a fake. The window includes
  `markApplied`, which is invoked from `group-agent-runner.ts:684-701` and so
  counts toward the turn's total.
- **AC2** — The context that reaches the model carries a `memoryContextBlock`
  identical to what it carries on `main`, on all four
  `prepareCompactionDeltaReplay` exit paths. Evidenced by per-path assertions on
  the context object handed to the model (stage 3), **not** by a rendering or
  golden-output test — the claim is about the context, and asserting it there is
  both narrower and harder to fake.
- **AC3** — `memoryContextBlock` is proven value-equivalent between a promoted
  and a non-promoted read of the same unchanged session, so the carry rests on
  a test rather than on an argument.
- **AC4** — When the fence mismatches (`agentSessionId` or
  `agentSessionResetAt` changed between the provisional and the later read),
  the carried block is discarded and that read re-hydrates. The turn is not
  dropped, and no pre-reset memory reaches the model.
- **AC5** — Reset (`/new`), compaction (`/compact`), pending-delta replay,
  too-stale/too-large degradation, maintenance-compaction, and resumed-provider-
  session paths each keep their existing behavior, with explicit coverage.
- **AC6** — Baseline-versus-after evidence from identical deterministic
  scenarios: repository operation counts and first-content-bearing latency at
  the parent commit and at the PR commit, plus an explicit statement of what
  did **not** improve.
- **AC7** — The redundant hydration sites are **deleted**, not left dormant
  behind a flag, after the replacement tests pass.
- **AC8** — Release gates green: `format:check`, `typecheck`, `lint`,
  `test:unit`, `test:integration`, `test:integration:postgres`,
  `test:integration:postgres:hot-path`, `test:e2e:agent:hermetic`,
  `check:architecture`, `verify.py`.

## Technical Approach

### The invariant

Memory hydrates exactly once per inbound turn, and the single hydration is the
one whose `memoryContextBlock` **reaches the model**. Stated against the
model-visible context, not "the final promoted context", because on the
pending-delta path those are different objects.

### The change

**Step 1 — `group-agent-runner.ts`.** The `loadTurnContext` closure
(`:140-156`) takes a second argument and forwards it:

```ts
const loadTurnContext = async (
  promoteReadyProviderSession: boolean,
  hydrateMemory = true,
) =>
  ops().getAgentTurnContext?.({
    /* unchanged */
    promoteReadyProviderSession,
    hydrateMemory,
  });
```

The provisional read at `:158` stays hydrating. **It is the one hydration** —
chosen because it is the only read that occurs on all four paths, so reusing it
costs no extra round trip and needs no restructuring of the delta branches.

**Step 2 — `group-agent-runner-compaction-delta.ts`.** Two changes.

First, widen the declared `loadTurnContext` parameter type at `:36-38`, which is
currently `(promoteReadyProviderSession: boolean) => Promise<TurnContext>`, to
accept the optional second argument. Without this the file will not typecheck.

Second, every later read becomes non-hydrating and takes the fenced carry
through one helper declared as a closure **inside**
`prepareCompactionDeltaReplay`, so it reads `input` directly rather than
re-threading three parameters that already live on `input`:

```ts
// The provisional read already paid for hydration; carry its block forward
// while the session is provably the same one.
const fencedFinalContext = async (promote: boolean): Promise<TurnContext> => {
  const provisional = input.turnContext;
  const next = await input.loadTurnContext(promote, false);
  if (
    next &&
    provisional &&
    next.agentSessionId === provisional.agentSessionId &&
    (next.agentSessionResetAt ?? null) === (provisional.agentSessionResetAt ?? null)
  ) {
    return { ...next, memoryContextBlock: provisional.memoryContextBlock };
  }
  // Session changed under us: the carried block belongs to a session that no
  // longer exists. Pay for one hydration rather than leak it.
  return input.loadTurnContext(promote, true);
};
```

Two call sites justify a named helper rather than inlining it twice; it stays a
closure rather than a module-level function because every input it needs is
already on `input`.

Applied per path:

| Path | Today | After |
| --- | --- | --- |
| maintenance (`:51-53`) | returns provisional | unchanged — already 1 |
| ordinary (`:59`) | `loadTurnContext(true)` hydrates | `fencedFinalContext(..., true)` |
| stale/large (`:101`) | `loadTurnContext(false)` hydrates | `fencedFinalContext(..., false)` |
| pending delta (`:105-112`) | provisional, already hydrated | unchanged — already 1 |
| `markApplied` (`:114`) | `loadTurnContext(true)` hydrates | `loadTurnContext(true, false)` — reads ids only (`:116-127`), never reaches the model |

`markApplied` is the pure win: it runs **after** the model call and only
extracts `providerSessionId`/`agentSessionId`/`externalSessionId` for
`markProviderSessionDeltaReplay`. Its hydration is unambiguously dead weight.

**Step 3 — instrument the real seam.** Wire `memory_hydrate_calls` to
`GroupProcessingRepository.getAgentTurnContext` as called at
`group-agent-runner.ts:141`, incrementing when `hydrateMemory !== false`. This
is what turns AC1 into a durable regression gate instead of a one-off check.

### Why this shape over the alternatives

Considered and rejected — recorded in the Decisions section:

- **Non-hydrating provisional + one final hydrated read.** Cleaner on paper, but
  the provisional read is model-visible on the maintenance and pending-delta
  paths, so those paths would need an extra hydrating read anyway. Larger diff,
  no fewer hydrations.
- **Drop the provisional read entirely.** Pending-delta detection is keyed on
  the provisional context's `latestProviderSessionReady`/`compactionDeltaReplay`
  fields (`compaction-delta.ts:50,54-57`). Removing it means reworking that
  detection — a semantic change under a latency task.
- **Hoist hydration out of `getAgentTurnContext` into a separate call.** Cleanest
  separation, biggest diff, and it changes a service contract shared with four
  other callers for the benefit of one. Rejected as over-building.

## Decisions

- `docs/decisions/0076-lat-3a-single-memory-hydration-per-turn.md` — **the
  governing record.** Fixes the invariant against the model-visible context;
  enumerates all four exit paths; picks provisional-read-reuse over
  non-hydrating-provisional; names the fence; requires the equivalence test;
  bounds the scope; and **rejects** carrying an expected session identity from
  admission, because the memory block is only reused between two reads inside
  one `runGroupAgent` call, so an in-runner comparison covers the entire reuse
  window. That rejection drops the production write scope from six files to
  two.
- `docs/decisions/0077-client-signoff.md` — LAT-3A sign-off. Needed its own
  record because `record_signoff.py` resolves the highest-numbered
  `NNNN-client-signoff.md` and would otherwise inherit LAT-2's 0072.
- Deferral **D-0018** — the scheduled-job hydrating path, with a revisit
  trigger.
- Deferral **D-0019** — whether the `first_visible` recall timeout behaves
  differently under one hydration, with a revisit trigger.

No further new decisions. Everything else follows from 0076, the existing
expected-id fence semantics, and lesson *architecture boundaries* (the change
stays inside runtime, touching no adapter or port contract).

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | **Changed** | Hydration count per inbound turn drops from 2 to 1 on three of four paths; the model-visible context is assembled from two reads on two of them. |
| API | **Unchanged by design** | No control handler, SDK contract, or port signature is touched; `loadTurnContext` is a local closure, not an exported contract. |
| Data / schema | **Unchanged by design** | No migration, no new column, no changed write. Fewer reads only; every write path is untouched. |
| CLI / ops | **Unchanged by design** | No command, setting, or `settings.yaml` key. Decision 0076 forbids a rollout flag, so there is nothing to operate. |
| UI | **N-A** | No user-visible surface; the turn's rendered output is byte-identical by AC2. |
| Docs | **Changed** | Decisions 0076 and 0077 added; the goal prompt's A4 plan-validation section corrected at source (its instruction was wrong for the pending-delta path). |
| Tests | **Changed** | Real-seam `memory_hydrate_calls` wiring, the exactly-once assertion, the promoted-vs-non-promoted equivalence test, and fence-mismatch/reset/compaction/delta-replay coverage. |
| Deferred | **Deferred** | Scheduled-job hydration (D-0018) and the `first_visible` recall-timeout question (D-0019), both with revisit triggers in `plans/deferrals.md`. |

## Task Decomposition

Bounded stages, one reviewed commit each, in order. Write scopes are disjoint
between stages 1 and 2 but stage 3 depends on stage 2, so these run
sequentially, not in parallel.

**Stage 1 — red-first baseline instrumentation (tests only).**
Write scope: `apps/core/test/`. Wire `memory_hydrate_calls` to the real
`GroupProcessingRepository.getAgentTurnContext` seam and assert
`=== 1` on the ordinary path plus per-call argument assertions. Also land the
AC3 promoted-vs-non-promoted equivalence test. Records the operation-count and
first-content baseline for AC6.

**"Red-first" here needs no commit checkout.** Stage 1's write scope is
tests-only, so running the new assertion on this branch *before* stage 2 edits
production code measures exactly the parent-commit behavior. It must report
**2**, and the assertion must fail. If it reports 1, the test is not wired to
the real seam and the phase's premise is unproven — stop and raise a Forge
signal rather than proceeding to stage 2.
Verify: `npm run test:unit`.

**Stage 2 — the production change.**
Write scope: `apps/core/src/runtime/group-agent-runner.ts`,
`apps/core/src/runtime/group-agent-runner-compaction-delta.ts`. Add the
hydration argument to the runner closure; widen the `loadTurnContext` parameter
type at `compaction-delta.ts:36-38`; add the `fencedFinalContext` closure; apply
it at `:59` and `:101`; make `markApplied`'s read non-hydrating. Stage 1's
assertion flips green. Delete the redundant hydration sites in the same stage
(AC7) — nothing is left behind a flag.
Verify: `npm run test:unit`, `npm run typecheck`, `npm run lint`.

**Stage 3 — path coverage and durable evidence.**
Write scope: `apps/core/test/`. Fence-mismatch (AC4), reset, `/compact`,
pending-delta replay, too-stale/too-large, maintenance-compaction, and
resumed-provider-session coverage (AC5). Real-Postgres integration coverage for
the session/context read behavior. Capture the after-measurement for AC6.
Verify: `npm run test:integration`, `npm run test:integration:postgres`,
`npm run test:integration:postgres:hot-path`.

Existing tests to expand rather than duplicate:
`apps/core/test/unit/runtime/group-processing.test.ts` (runner call-arg
coverage), `session-resume-runtime.test.ts` (provisional-vs-promoted
pending-delta assertions), `bootstrap/live-execution.test.ts` (admission's
non-hydrating call), `canonical-ops-repo.postgres.test.ts` (service hydration
skip/default), `session-continuity.postgres.integration.test.ts` (reset/resume).

## Risks

- **A second hydration-only field is added to the return type later**, and
  someone extends the overlay by copy-paste instead of rethinking it. Today the
  overlay is safe precisely because `memoryContextBlock` is the *only*
  hydration-derived field. Mitigation: decision 0076 records that this must be
  revisited, not extended, if a second such field appears; the equivalence test
  pins the current shape. **Tripwire:** if review flags the two-read assembly as
  a maintainability risk more than once, escalate per WORKFLOW.md Recurring
  Findings rather than patching a third time.
- **Reset race between the provisional and the later read** leaks pre-reset
  memory. This is the whole reason the fence exists; AC4 covers it with a test
  that forces the mismatch. Fail-safe (re-hydrate), not fail-closed (drop turn).
- **Equivalence assumption is wrong** — promotion does somehow affect recall.
  AC3 is exactly the falsification test; if it fails, the approach is wrong and
  the fallback is the non-hydrating-provisional design from Technical Approach, recorded via a
  Forge signal rather than improvised.
- **The pending-delta path is subtle** and its provisional context is
  model-visible. A careless "make the provisional read non-hydrating" would ship
  a memory-less turn. This is the trap the handover walked into; the per-path
  table in Technical Approach and decision 0076 exist to stop it recurring.
- **Measurement is unit-level.** Removing one repository fan-out is a real but
  modest saving; AC6 requires stating plainly what did not improve rather than
  implying a large end-to-end win.
- **`hydrateMemory` default `true` in the closure** preserves today's behavior
  for any caller I miss, so a missed site fails *slow*, not *wrong*. The
  exactly-once assertion is what catches a missed site.

## Verify Plan

Falsification first, then the gates.

1. **Baseline must be red.** Stage 1's `memory_hydrate_calls === 1` assertion
   run at the parent commit must FAIL (observed 2). A green baseline means the
   test is not wired to the real seam and the phase's premise is unproven —
   stop and raise a Forge signal.
2. **AC3 must be able to fail.** The equivalence test compares a promoted and a
   non-promoted read of one unchanged session; confirm it fails if
   `memoryContextBlock` is deliberately perturbed.
3. **AC4 must be able to fail.** Force an `agentSessionResetAt` change between
   reads; confirm the carry is discarded and a re-hydration occurs. Confirm the
   test fails if the fence comparison is removed.
4. Per-stage: smallest relevant suite, then local autoreview on the
   **uncommitted** diff until clean, then commit.
5. Branch closeout, in order:
   `npm run format:check`, `npm run typecheck`, `npm run lint`,
   `npm run test:unit`, `npm run test:integration`,
   `npm run test:integration:postgres`,
   `npm run test:integration:postgres:hot-path`,
   `npm run test:e2e:agent:hermetic`, `npm run check:architecture`,
   `/opt/homebrew/bin/python3 .agents/scripts/verify.py`.
6. **Real Postgres, on a disposable container.** `GANTRY_TEST_DATABASE_URL` is
   unset in this environment and no local server is listening, so stage 3 stands
   up its own throwaway Docker Postgres per
   `docs/architecture/current-verification-commands.md:146-152`: enable `vector`
   and `pg_trgm` before migrations, run the suites, then **stop and remove the
   container**. A missing `GANTRY_TEST_DATABASE_URL` is a blocker, not a pass
   (Program Acceptance §6). The persistent `gantry-postgres` container on
   127.0.0.1:5432 backs real developer data under `~/gantry/postgres` and is
   **off limits** for verification. (Noted in passing: `gantry-lat0-pg-verify` on
   63211 is a disposable container LAT-0 left behind; not this task's to clean,
   but it should not be reused either.)
7. ONE branch-wide autoreview run, three lenses, then record the three review
   artifacts.
8. Measurement for AC6 from identical deterministic scenarios at parent commit
   and PR commit.
9. Per client direction, model-key-only E2E and the KnackLabs lead-generation
   runtime check may be recorded as **environment-blocked**; all non-key
   hermetic E2E behavior relevant to this phase must pass.
