---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-28
---

# Require atomic async-task admission and claim on the repository port

## Context

The async-task repository port declares its atomic operations as **optional**
(`apps/core/src/domain/ports/async-tasks.ts:178-184`):
`createTaskWithBacklogAdmission?`, `createTaskWithScopedAdmission?`, and
`claimQueuedTask?`. When an implementation omits them, admission silently falls
back to a **count-then-create** sequence
(`apps/core/src/jobs/async-task-admission.ts:38-49`): it counts the current
backlog, then creates the task in a separate operation. Two concurrent callers can
both pass the count and both create, exceeding the configured cap. The drainer has
the same shape — it checks running capacity and then claims
(`apps/core/src/jobs/async-command-task-drainer.ts:29-42`).

The production Postgres adapter implements all three atomically
(`adapters/storage/postgres/repositories/async-task-repository.postgres.ts`), so
this is **not a live production race** — it is an *adapter-contract hazard*: the
type system currently permits an implementation that gets the unsafe path, and
nothing fails loudly when it does.

## Decision

1. **Make the three atomic operations required** on the port — drop the `?`. An
   async-task repository that cannot admit and claim atomically is not a valid
   implementation of this port.

2. **Delete the count-then-create fallback** (`createTaskWithLocalAdmission` and
   the capacity-check-then-claim fallback in the drainer). The unsafe path stops
   existing rather than being made "safe enough"; per the no-backward-compatibility
   policy there is no shim and no deprecation period.

3. **Pin the contract with a concurrency test.** A shared contract test asserts
   that concurrent admissions cannot exceed the cap, so a future adapter is caught
   by a failing test rather than by silently inheriting a weak path.

### Rejected alternative

Keeping the fallback but serializing it in-process (a per-scope promise chain, the
shape used in RACE-6) would have been ~10 lines with no ripple, and would make the
fallback correct for a single-process adapter. It was rejected because it *retains*
an unsafe contract: a future multi-process non-Postgres adapter would still exceed
the cap, and the port would still advertise atomic admission as optional. Deleting
the weak path makes the invariant structural — the type system enforces it — and is
a net code reduction.

## Consequences

- **Touched:** `domain/ports/async-tasks.ts` (three `?` removed),
  `jobs/async-task-admission.ts` (fallback deleted),
  `jobs/async-command-task-drainer.ts` (fallback deleted), and roughly seven test
  doubles that implement the port and now need the three methods. The Postgres
  adapter is **unchanged** — it already satisfies the contract.
- **Ripple is mechanical and test-only.** No production adapter changes, no schema
  change, no runtime behavior change on the Postgres path.
- **Tradeoff accepted:** every future test double must supply atomic admission.
  That is the point — a double that cannot is not modelling the real contract.
- Closes RACE-8 (latent). The sibling latent item RACE-9 (unlocked
  read-modify-write on the no-revision-store settings fallback) is tracked
  separately.
