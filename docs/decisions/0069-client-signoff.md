---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-27
---

# LAT-0 Client Signoff

## Context
The user authorized the all-phase MyClaw response-latency program, requiring
separate bounded Forge PRs, Node 25, Ponytail simplicity, reviewed-before-commit
discipline, full integration/E2E/autoreview, checkout-bound KnackLabs runtime
smoke for runtime PRs, and ignored `@session-state.md` coordination state.

The archived Phase 0 branch proved only a narrow two-file shared harness port:
generic primitives, warm/new-session fixture behavior, and ten-instance
isolation. That was not enough for the user-supplied Phase 0 measurement
contract. An earlier fresh-worktree draft incorrectly narrowed LAT-0 to that
old 17-test primitive scope; this decision revises signoff upward before any
commit.

Current active Decision 0066 already accepts app/content-addressed skill
artifact refs and read-time hash verification, so Phase 6 cannot replay that
old roadmap scope as future work.

## Decision
Proceed with LAT-0 planning and later implementation as the full test-only
Phase 0 response-latency measurement harness on branch
`perf/response-latency-baseline` from
`db41baa550a5779f119bf2cfa1b9890856afc69d`.

LAT-0 authorizes deterministic support for the user's exact S1-S12 scenario
contracts, all named operation counters and boundary delays, first-content
metric support, bounded concurrency barriers, fake streaming model/channel
support, and a separate explicitly Postgres-gated query-counting helper.

S11 is the 500-job large-cardinality baseline and S12 is the IPC 5,000-marker
baseline. Because their production fixes already exist, LAT-0 records their
current deterministic baselines using existing behavior/tests rather than
renaming or redefining those scenario IDs.

LAT-0 does not authorize production behavior changes, real provider calls, real
S3 network dependency, real remote MCP network dependency, or later phase
optimizations. Later phases may add phase-specific before/after assertions
using the LAT-0 fixtures.

## Consequences
Forge may record the LAT-0 plan and decomposition after the required plan grill.
Implementation remains limited to test-only write scope under `apps/core/test/`,
including:

- `apps/core/test/harness/response-latency-harness.ts`
- `apps/core/test/unit/runtime/response-latency-contract.test.ts`
- `apps/core/test/harness/response-latency-scenarios.ts`
- `apps/core/test/unit/runtime/response-latency-scenarios.test.ts`
- `apps/core/test/harness/response-latency-postgres.ts`
- `apps/core/test/integration/response-latency-postgres.integration.test.ts`

Every commit still needs local autoreview before commit. The task cannot be
PR-ready until automated tests, deterministic verify, one three-lens autoreview
run, and CI pass. Runtime PRs must prove the installed KnackLabs local service
points at the active checkout before running the lead-maintenance smoke; LAT-0
is test-only, so that runtime smoke is not a LAT-0 gate.
