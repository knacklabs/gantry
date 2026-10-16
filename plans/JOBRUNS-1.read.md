---
reader: codex (gpt-6.1-sol)
read_at: 2026-10-09T15:45:24+00:00
read_hash: 0dacdb8494f11f508bb174a0dd8af80ea64c31b2
round: 3
passed: yes
doc_seen: 0dacdb8494f11f508bb174a0dd8af80ea64c31b2
spec_seen: 2b25d412b19afbf91d00962923ad6d3e1490d97f
notes_seen: 0729ef94affa102c3c86ca9000c380b1a2669f6d
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc, then run
`forge read <doc>` again for the next round, until a round finds nothing:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options.

## Round 1

1. Unproven: item 1: saving a job link does not make tasks findable by job.
   `AsyncTaskListFilter` has no `parentJobId` filter (`apps/core/src/domain/ports/async-tasks.ts:132`), and the Postgres query only filters by run (`async-task-repository.postgres.ts:381`). The proposed assertions can pass while job lookup remains unavailable. Pin the job-filter contract and exercise it in the integration test, excluding another job’s tasks.
   Disposition: keep, amended: Done-when now promises the record, not a lookup; the integration test reads rows back by parent_job_id and excludes another job's tasks; no port filter is added because nothing lists tasks by job yet (noted for SUB-2).

2. Cut or defer: “is stopped … with [the job]” promises cancellation behavior excluded by the confirmed spec.
   `plans/JOBRUNS-1.md:8` promises this for all background work, while `docs/specs/job-background-work-saves.md:46` explicitly leaves subagent cancellation when the job ends to SUB-2. Limit the promise to saved links and existing recovery behavior.
   Disposition: cut: the promise now says the work is recorded against the job and run.

3. T1’s Scope excludes the files needed for its required proof.
   The scope names production files, migrations and existing unit tests, but neither the promised Postgres integration/migration tests nor `apps/core/test/e2e/job-background-work…`. Name those test files in Scope so the builder can deliver the Tests cell without additional authorization.
   Disposition: keep, amended: the three test files are named in T1's Scope.

4. Unproven: item 1: the integration test does not pin coverage of both IPC and inline delegation.
   These are separate entry paths, and both currently clear the job’s run link (`ipc-delegated-agent-execution.ts:54`, `inline-agent-task-lifecycle.ts:91`). An IPC-only job-dispatch test would pass with inline delegation still broken. Exercise both lanes within the same owner integration suite.
   Disposition: keep, amended: the suite starts the subagent through both the IPC and the inline lane.

5. Unproven: item 2: the migration test cannot detect overwriting existing canonical links.
   Its fixtures have only the duplicate link. An unconditional backfill would pass while replacing an existing `parent_run_id` or `parent_job_id`, contrary to the “where null” rule. Add a fixture with populated canonical links and assert they survive while missing links are filled.
   Tests and migrations were not run; overwriting existing links remains a data-loss risk.
   Disposition: keep, amended: the migration test adds a task with its own links plus an old-field link and asserts its links survive.

## Round 2

6. No findings.
   Disposition: keep: the reader reported no findings; nothing to change.

Tests and migrations were not run; implementation remains unverified.

## Round 3

No findings.
