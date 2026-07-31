---
status: accepted
confirmed_by: "user"
date: 2026-07-29
---

# Persist completed streamed generations before run finalization

## Context

Streaming delivery can complete a visible assistant generation while the
provider runner remains open. Persisting only at run finalization leaves the
messages API behind the visible response and can take minutes to converge.

## Decision

Persist each completed visible streamed generation immediately after delivery
settlement. Intermediate chunks are never messages, and run finalization must
not persist the same generation again.

## Consequences

- The messages API becomes prompt and durable during an active run.
- One generation produces one message row, including interaction-boundary
  flushes.
- Partial delivery records `partially_sent`; wholly undelivered output is not
  marked as sent.
- Persistence failure is logged without undoing completed delivery.
