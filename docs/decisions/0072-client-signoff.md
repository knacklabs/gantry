---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-28
---

# LAT-2 Client Signoff

## Context
The user explicitly approved the comprehensive MyClaw response-latency program
and required every phase to run as its own Forge branch and PR with normal
planning, tests, review, commit, CI, and runtime-smoke gates.

The program roadmap names Phase 2 as "One Immutable Per-Turn Access Snapshot"
on branch `perf/agent-access-snapshot`: load active tool bindings, enabled
skills, and materialized MCP server rows once per turn, then derive tool policy,
selected-skill displays, skill actions, semantic capability context, capability
catalog, and access fingerprint through pure value-equivalent projections.

## Decision
Proceed with LAT-2 planning and later implementation as the bounded per-turn
agent access snapshot phase.

LAT-2 authorizes red-first operation-count and equivalence tests, then the
smallest production change needed to load one canonical per-turn snapshot for
active tools, enabled skills, and materialized MCP servers, with exactly one
query family for each materialized surface. Runtime callers must derive their
existing projections from that immutable snapshot without changing durable
authority semantics.

LAT-2 does not authorize provider gateway changes, permission policy changes,
settings/schema changes, durable grant model changes, public API/CLI changes,
new caches or warm-resource pools, or deletion of admin/review functions.

## Consequences
Forge may record the LAT-2 plan and decomposition after the required plan grill.
Implementation remains limited to the runtime access materialization hot path
and focused tests around operation counts, value equivalence, fail-closed access
semantics, and no remaining duplicate production hot-path callers before
deletion.

Each runtime-behavior commit needs an independent local code review before
commit. The task cannot be PR-ready until automated tests, deterministic verify,
one final three-lens autoreview run after implementation, CI, and the
checkout-bound KnackLabs runtime smoke required for runtime PRs have passed.
