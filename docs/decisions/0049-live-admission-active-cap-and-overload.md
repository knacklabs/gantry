---
status: proposed
confirmed_by: ""
date: 2026-07-24
---

# Live-Admission Active Cap And Overload Outcome

## Context

Eligible inbound messages unconditionally insert durable live-admission work
items (`apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts:51`);
no per-app quota exists and the process-local `maxMessageBacklog` defaults to
unlimited and cannot bound the durable table. The audit also flags missing
terminal retention — an architecture decision this record explicitly does NOT
make.

## Decision

Enforce a finite, settings-backed per-app active cap
(`runtime.queue.max_live_admission_backlog`, default 100) atomically inside
the admission transaction, reusing the advisory-lock + count pattern from
`async-task-repository.postgres.ts:41`. Active = queued/claimed/deferred;
terminal rows consume no capacity (partial active-by-app index added). Over-cap
distinct deliveries persist their canonical message/event but return an
explicit internal `overloaded` outcome — no work item, no wakeup. Exact
duplicates still return the existing item at capacity. Terminal retention,
purge/archival, and per-conversation caps are deferred to SPS-4 (deferral
D-0010).

## Consequences

- A traffic storm can no longer grow the active backlog without bound; the
  canonical conversation record is still durably kept.
- `overloaded` is a new internal outcome callers must handle; public API
  schemas unchanged.
- Terminal-row growth remains unbounded until SPS-4 lands (tracked with a
  revisit trigger).
