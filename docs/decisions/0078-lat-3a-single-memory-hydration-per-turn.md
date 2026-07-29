---
status: proposed
confirmed_by: ""
date: 2026-07-28
---

# LAT-3A: Hydrate Agent Memory Exactly Once Per Inbound Turn, Behind A Session-Identity Fence

## Context

The response-latency roadmap names Phase 3A "Single Memory Hydration" and
states it "needs fence redesign before implementation" without naming the
fence (`plans/MyClaw-Response-Latency-Refactor-Plan.md`, Phase 3A). The
messaging hot-path goal prompt is more specific but, as written, is wrong
about one path (`docs/architecture/messaging-hotpath-and-liveness-goal-prompt.md`,
plan-validation §4): it instructs "hydrate memory exactly once against the
final promoted context."

Read-only exploration of `origin/main` @ `55ddfca7c` establishes the actual
shape.

Memory hydration is one field. `getAgentTurnContext` returns exactly one
hydration-derived value, `memoryContextBlock?: string`
(`apps/core/src/adapters/storage/postgres/services/canonical-session-ops-service.ts:191-192,224`).
Every other returned field is repository-derived. The hydration gate is
`input.hydrateMemory === false ? undefined : hydrate(...)` (`:213-221`) —
omission hydrates. One hydration fans out across `agent_sessions`,
`agent_session_digests`, `memory_items`, `conversations`, `canonical_jobs`,
and `control_http_sessions`
(`apps/core/src/application/sessions/hydrate-agent-context-service.ts:106-135`).

Admission is already correct and is load-bearing. It calls
`getAgentTurnContext` with an explicit `hydrateMemory: false` and no promotion
(`apps/core/src/app/bootstrap/live-execution.ts:224-232`); that call resolves
canonical app/session scope, ensures the agent session, releases stale
maintenance locks, optionally promotes a ready provider session, and selects
the latest resumable provider session
(`apps/core/src/adapters/storage/postgres/repositories/canonical-session-repository.postgres.ts:58-104`).
It cannot be dropped.

The waste is entirely inside the runner. The runner takes a provisional read
that hydrates by omission (`apps/core/src/runtime/group-agent-runner.ts:140-159`),
then `prepareCompactionDeltaReplay` takes a second read that also hydrates by
omission (`apps/core/src/runtime/group-agent-runner-compaction-delta.ts`).
That helper has four exit paths, and the context that reaches the model
differs per path:

| Path | Exit | Model-visible context | Hydrations |
| --- | --- | --- | --- |
| maintenance session | `:51-53` | provisional | 1 |
| ordinary (no pending delta) | `:54-62` | promoted read `loadTurnContext(true)` | 2 |
| delta too stale / too large | `:85-103` | non-promoted read `loadTurnContext(false)` | 2 |
| pending delta replay | `:105-130` | **provisional** (`replayTurnContext`) | 2 |

So the goal prompt's phrasing is wrong for the pending-delta path: there the
model consumes the provisional context, and the later promoted read inside
`markApplied` (`:113-128`) only extracts identifiers for
`markProviderSessionDeltaReplay` — it never reaches the model. "The final
promoted context" is not the model-visible context on that path.

The prompt is also incomplete: it frames this as the runner hydrating twice,
but three of the four paths waste exactly one hydration, and which read is the
wasted one differs by path.

No accepted decision currently governs how many times agent memory may
hydrate per turn, so "exactly once" is not a checkable contract today. No
existing test asserts the real runner's per-turn hydration count; the Phase 0
harness owns a `memory_hydrate_calls` counter
(`apps/core/test/harness/response-latency-harness.ts:46-89`) but its S4
scenario increments it through a fake seam
(`apps/core/test/harness/response-latency-scenarios.ts:185-217`), not the real
runner.

Finally, reuse of a memory block across two reads is only safe if the agent
session did not change between them. A `/new` reset between the provisional
and final read would otherwise leak pre-reset memory into a post-reset turn.
The repository already owns exactly this comparison on the write side —
`expectedAgentSessionId` and `expectedAgentSessionResetAt`, checked inside a
`SELECT ... FOR UPDATE` and returning `false` on mismatch
(`canonical-session-repository.postgres.ts:454-475`), carried from the runner
at `group-agent-runner.ts:220-263`. Admission builds `LiveTurnScope` from
`appId` and `agentSessionId` only and does not carry reset-at forward
(`live-execution.ts:234-239`).

## Decision

**The invariant.** Agent memory hydrates **exactly once per inbound turn**,
and the single hydration is the one whose `memoryContextBlock` reaches the
model for that turn. The invariant is stated against the **model-visible**
context, not against "the final promoted context" — because on the
pending-compaction-delta path those are different objects.

**The mechanism — reuse the first read, fence the reuse.** The runner's
provisional read keeps hydrating; it is the one hydration. Every later read in
the same turn is issued with `hydrateMemory: false`, and the model-visible
context takes `memoryContextBlock` from the provisional read. This is chosen
over making the provisional read non-hydrating because the provisional read is
the only read that happens on all four paths, so reusing it needs no extra
repository round trip and no restructuring of the delta branches.

**The fence, and why it is narrower than the roadmap suggested.** Carrying a
memory block across reads is permitted only while the agent session identity is
unchanged. The comparison is `agentSessionId` plus `agentSessionResetAt`,
matching the field names and semantics already established for provider-session
writes at `canonical-session-repository.postgres.ts:454-475` rather than
inventing a second fence vocabulary. On mismatch the carried block is
**discarded and that read re-hydrates** — one extra read on a rare reset race
is the correct price, and the turn degrades to today's behavior rather than
proceeding with memory from a session that no longer exists. Fail-safe, not
fail-closed: a reset must not drop the user's turn, and it must not leak the
previous session's memory either.

The same revalidation is applied on the pending-compaction-delta path before
committing to the replay, because that path feeds the provisional context
straight to the model. On mismatch the replay is dropped entirely — a pending
delta belongs to a session that no longer exists — and the context re-hydrates.

**What the fence does and does not guarantee.** It guarantees the carried block
is consistent with an agent session observed **at fence time**: no carry
survives an `agentSessionId` or `agentSessionResetAt` change detected up to that
point. It does **not** eliminate the window between the last context read and
the model call. A `/new` landing inside that window still puts the previous
session's block in front of the model.

That residual window is **pre-existing and universal** — every path on `main`
has it today, including the ordinary path, because any read-then-use sequence
does. LAT-3A neither introduces nor widens it, and materially narrows it on the
pending-delta path, which previously spanned `getDeltaMessages` plus the degrade
writes and now spans only the function return. Closing it properly needs a fence
or serialization protocol valid through model-call commitment, entangled with
the runner, the live-turn lease, and the model-invocation boundary, and it would
serialize resets against long-running generations. That is cycle-sized work,
SPLIT OUT as deferral **D-0024** with a revisit trigger per WORKFLOW.md
Recurring Findings, rather than patched a third time here.

This paragraph exists because an earlier draft of this record asserted reset
isolation flatly, and review was right to call that an overclaim.

The roadmap and the goal prompt both suggested carrying the **admission**
session identity forward as the fenced expected id. That is REJECTED as
unnecessary for this invariant. The memory block is only ever reused between
the runner's provisional read (`group-agent-runner.ts:158`) and the
model-visible read taken microseconds later inside
`prepareCompactionDeltaReplay` — both inside one `runGroupAgent` call. An
in-runner provisional-versus-final comparison therefore covers the entire reuse
window. Threading `expectedAgentSessionId`/`expectedAgentSessionResetAt` from
admission would add plumbing across `live-execution.ts`, the live-turn port
types, `group-processing-types.ts`, and `group-processing.ts` to detect a
reset in a window where no memory block is being carried. If a reset lands
between admission and the provisional read, the provisional read simply
observes the new session and hydrates the correct memory for it. Admission-to-
runner session drift is a real but SEPARATE property, already partly held by
the existing expected-id fence on provider-session writes
(`group-agent-runner.ts:249-250`); it is not this phase's concern and must not
be smuggled in under a latency task.

**Value equivalence is proven, not assumed.** Promotion mutates provider-session
rows only; it does not touch `memory_items` or `agent_session_digests`.
LAT-3A must land an equivalence test asserting `memoryContextBlock` is
identical between a promoted and a non-promoted read of the same unchanged
session, so the reuse rests on a test rather than on this argument.

**Scope boundaries.** LAT-3A changes two production files only:
`apps/core/src/runtime/group-agent-runner.ts` (the `loadTurnContext` closure
gains a hydration argument) and
`apps/core/src/runtime/group-agent-runner-compaction-delta.ts` (each later read
becomes non-hydrating and takes the fenced carry). No port, scope, or
queue-payload type changes, because the fence is in-runner.

LAT-3A does **not** change: the admission call's arguments or semantics;
`HydrateAgentContextService` itself; the memory recall query, its 250 ms
`first_visible` lexical-only timeout, or any scoring behavior; the durable
memory, session, admission, cursor, or provider-account authority boundaries;
the scheduled-job hydrating call at `apps/core/src/jobs/execution.ts:324-335`
(a job is not an inbound turn); the non-hydrating control, recovery, and
inline-task callers; settings, schema, public API, CLI, or permission
surfaces. No cache, no warm pool, no cross-turn mutable state, no rollout
flag.

## Consequences

Forge may record the LAT-3A plan and decomposition after the required plan
grill, and implementation is bounded to the seams named above.

Expected measured delta: `memory_hydrate_calls` per inbound turn goes from 2
to 1 on the ordinary, too-stale/too-large, and pending-delta paths, and stays
at 1 on the maintenance path. The removed hydration is one fan-out across six
tables, so the PR must report repository operation counts and
first-content-bearing latency at the parent commit and at the PR commit from
identical deterministic scenarios, and must state explicitly what did not
improve.

Deleted after parity proof: the redundant hydration argument sites, and the
now-unnecessary hydration inside `markApplied`'s bookkeeping read.

New durable obligation: the `memory_hydrate_calls === 1` assertion becomes a
regression gate wired to the real runner seam, so a future re-introduction of
a second hydration fails a test instead of silently costing latency. Reset,
promotion, compaction-delta, and resumed-session paths each need explicit
coverage, including the fence-mismatch path.

Accepted tradeoff: the model-visible context on the ordinary path is now
assembled from two reads — repository fields from the promoted read, memory
from the provisional read. That is a real seam that could rot if someone later
adds a second hydration-derived field to the return type without extending the
carry. The equivalence test plus the exactly-once assertion are the guards;
if the return type ever grows a second hydration-only field, this decision
must be revisited rather than extended by copying the overlay.

Corrects `docs/architecture/messaging-hotpath-and-liveness-goal-prompt.md`
plan-validation §4, whose "hydrate exactly once against the final promoted
context" instruction is wrong for the pending-compaction-delta path. That doc
is edited in this task to match this decision.

Out of scope, each deferred with a revisit trigger:

- **D-0022** — the scheduled-job hydrating call (`jobs/execution.ts:324-335`),
  the same waste on a path that is not latency-critical.
- **D-0023** — whether the `first_visible` recall timeout behaves differently
  under a single hydration.
- **D-0024** — the residual TOCTOU window between the last context read and the
  model call, split out per WORKFLOW.md Recurring Findings after the same class
  surfaced twice.
