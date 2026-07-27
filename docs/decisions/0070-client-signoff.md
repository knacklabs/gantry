---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-27
---

# LAT-1 Client Signoff

## Context
The user explicitly signed off the full MyClaw response-latency program and
specifically ordered Phase 1 planning on branch
`perf/parallel-inline-mcp-startup`.

The program roadmap names Phase 1 as bounded concurrent remote MCP startup:
connect and discover remote MCP servers with a small local concurrency limit
while preserving deterministic server/tool order, guarded fetch, headers, abort
handling, host denylist behavior, and exact cleanup of connected clients.

This branch is intentionally stacked on Phase 0. `main` now contains decision
0068, while the stacked Phase 0 signoff currently also occupies 0068 on this
branch. Phase 0 must be renumbered to 0069 during the post-merge rebase, so
LAT-1 reserves 0070 for this signoff and must not use 0068 or 0069.

## Decision
Proceed with LAT-1 planning and later implementation as the bounded concurrent
remote MCP startup phase for the DeepAgents inline lane.

LAT-1 authorizes a red-first contract test for current serial remote MCP startup,
the smallest production change needed to connect/list remote MCP servers with at
most four concurrent starts, deterministic final tool order, fail-closed denylist
and abort handling, header/guarded-fetch preservation, and cleanup of every
client connected before any failure.

LAT-1 does not authorize checkpoint pool reuse, reusable warm resource pools,
long-lived MCP clients across turns, Anthropic SDK lane changes, provider
gateway changes, permission policy changes, storage schema changes, real remote
MCP network dependency in tests, or changes to Phase 0 measurement fixtures.

## Consequences
Forge may record the LAT-1 plan and decomposition after the required plan grill.
Implementation remains limited to the inline DeepAgents remote MCP startup seam
and focused tests around that seam.

The branch must be rebased after Phase 0 merges so the stacked decision corpus
contains `0069-client-signoff.md` for LAT-0 and this
`0070-client-signoff.md` for LAT-1 without collisions.

Every runtime-behavior commit still needs local autoreview before commit. The
task cannot be PR-ready until automated tests, deterministic verify, one
three-lens autoreview run, CI, and the checkout-bound KnackLabs runtime smoke
required for runtime PRs have passed.
