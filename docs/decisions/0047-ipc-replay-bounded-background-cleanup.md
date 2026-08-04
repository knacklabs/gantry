---
status: proposed
confirmed_by: ""
date: 2026-07-24
---

# IPC Replay Bounded Background Cleanup

## Context

Every signed IPC request currently runs `pruneConsumedIpcRequestIds`, which
synchronously lists, reads, and parses every replay-marker file in
`DATA_DIR/ipc-replay` before reserving a new marker
(`apps/core/src/runtime/ipc-auth-validation.ts:206`, `:286`). Work per request
grows with the live marker count (~quadratic in request rate over the 5-minute
retention window) and starves the event loop.

## Decision

Replay cleanup moves OFF the request-admission path: an async, bounded sweeper
runs outside request validation; the hot path keeps hash-addressed markers and
atomic `wx` create-if-absent, and on `EEXIST` inspects only the single
addressed marker to preserve expiry/retry semantics. The request path never
calls `readdirSync` or parses unrelated marker files.

## Consequences

- Bounded, count-independent filesystem work per validation (proved by a
  5,000-marker instrumented test); replay rejection, freshness, and restart
  durability unchanged.
- A background sweeper handle now exists and must be lifecycle-managed
  (no leaked timers).
- Rejected: expiry-bucketed directories and a durable TTL store — more moving
  parts than the bounded sweeper needs at current scale.
