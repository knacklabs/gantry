---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-28
---

# LAT-3A Client Signoff

## Context

The client authorized the complete remaining MyClaw response-latency program
in chat on 2026-07-28, naming the delivery order and requiring every phase to
run as its own fresh worktree, branch, Forge run, and PR from the latest
`origin/main`, with the full intake, sign-off, planning, decomposition,
implementation, verification, review, test-recording, and `pr_ready`
lifecycle. Merging stays behind the repository's human merge gate, and the next
implementation phase may not start from an unmerged feature branch.

LAT-3A is the first remaining phase: the roadmap's Phase 3A, "Single Memory
Hydration", on branch `perf/phase3a-single-memory-hydration`
(`plans/MyClaw-Response-Latency-Refactor-Plan.md`). The roadmap flags it as
needing a fence redesign before implementation.

The client also required that each phase's baseline be reproduced with the
merged response-latency harness before production behavior changes, and that a
Forge signal be raised instead of forcing the implementation if the stated
problem does not reproduce. The problem DOES reproduce on `origin/main`
@ `55ddfca7c`: the runner hydrates agent memory twice on three of the four
`prepareCompactionDeltaReplay` exit paths. No signal was raised. The evidence
and the corrected contract are recorded in
`docs/decisions/0076-lat-3a-single-memory-hydration-per-turn.md`, and the
sign-off grill verdict is in `.factory/grills/signoff.json`.

## Decision

Proceed with LAT-3A planning and implementation as the bounded single-memory-
hydration phase, under the invariant and fence recorded in decision 0076.

LAT-3A authorizes a red-first operation-count assertion wired to the real
`GroupProcessingRepository.getAgentTurnContext` seam, an equivalence test for
the carried memory block, and then the smallest production change that makes
agent memory hydrate exactly once per inbound turn against the model-visible
context, behind the `expectedAgentSessionId`/`expectedAgentSessionResetAt`
fence.

LAT-3A does not authorize changes to the admission call's semantics,
`HydrateAgentContextService`, the memory recall query or its `first_visible`
timeout, the scheduled-job hydrating path, durable memory/session/admission/
cursor/provider-account authority boundaries, settings, schema, public API,
CLI, or permission surfaces. No cache, no warm pool, no cross-turn mutable
state, and no rollout flag.

## Consequences

Forge may record the LAT-3A plan and decomposition after the required plan
grill.

The PR must report parent-commit baseline and PR-commit after evidence from
identical deterministic scenarios, repository operation counts, first-content-
bearing latency, correctness/failure/cancellation/concurrency/security
coverage, an explicit statement of what did not improve, and deletion of the
replaced duplicate hydration sites after the replacement tests pass.

Each runtime-behavior commit gets a local autoreview on its uncommitted diff
before it is committed. The task is not PR-ready until automated tests,
deterministic verify, one branch-closeout three-lens autoreview, and CI have
passed. Per explicit client direction, model-key-only E2E and the KnackLabs
lead-generation runtime check may be recorded as environment-blocked; all
non-key hermetic E2E behavior relevant to this phase must pass.

Merging remains human-gated. Phase 3B does not start until LAT-3A is merged
into `main`.
