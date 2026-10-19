# Background work started by a job is saved and finishes

1 part · Risks: a one-way migration deletes the unused job-results table · New moving parts: none

## What changes for you

- A scheduled job can now run a long command, a slow tool call or a subagent in the background, the same as a chat can. Today a job's long commands and slow tool calls fail as soon as they start.
- Background work a job starts is recorded against that job and the run that started it.

## Why

When a job starts background work, Gantry saves a record that should say which run and which job started it. For long commands and slow tool calls, that record points at an old job-results table that nothing has written to since job results moved, so saving fails. Subagents started by a job save, but without any link back to the job or its run. This story gives every piece of background work one run link and one job link, and removes the old table. It delivers [Background work started by a job is saved and finishes](../docs/specs/job-background-work-saves.md).

## Done when

1. **A long command, a slow tool call and a subagent started by a scheduled job each run to their outcome, and each is recorded against the job and the run that started it.**
2. **The old job-results table is gone, and background work that pointed at it keeps its job and, where one existed, its run.**

## Risks

- **One-way migration.** It deletes the old job-results table and the duplicate link on background work. Nothing reads the table today. Before deleting, it copies each link it can into the remaining fields, so no background work loses its job or a run it had.

## For the builders

### Done-when details

1. **One run link and one job link for every kind.** Today `parent_run_id` points at `agent_runs`, `parent_job_id` at `jobs`, and `parent_job_run_id` at the unused `job_runs`. Job paths set `parent_run_id` to null and put the agent-run id into `parent_job_run_id`, which breaks the foreign key: `ipc-agent-task-lifecycle-handlers.ts:364-367` (background commands) and `async-mcp-tool-task.ts:99-101` (slow tool calls). The subagent paths clear the run link for jobs and pass no job link: `ipc-delegated-agent-execution.ts:54`, `inline-agent-task-lifecycle.ts:91`, and `application/core-tools/task-lifecycle.ts:197` (`startDelegatedAgent` gets no `parentJobId`). `structured-local-cli-invocation.ts:94-95` already does it right (`parentRunId: runId`, `parentJobId: jobId`); every path follows that one shape.
   - Edge cases: a chat-started task keeps `parent_job_id` null; a job-started task without a run id saves with the job link only; recovery (`runtime-services-async-task-recovery.ts`, `async-command-queue-recovery.ts`) carries both links unchanged.
   - Tests: one Postgres integration suite starts a background command, a slow tool call and a subagent through the production job dispatch, lets each reach its outcome, and reads the saved rows back by `parent_job_id`, asserting each holds the job's agent run in `parent_run_id` and that another job's tasks are not returned. The subagent is started through both lanes, the IPC delegation path and the inline lane, in the same suite. A chat-started case asserts `parent_job_id` stays null.
   - Not added: a job filter on the task-listing port. No caller lists tasks by job yet; SUB-2's job cancellation adds the lookup it needs. Named end-to-end test `job-background-work` in `apps/core/test/e2e/`: a scheduled job runs a background command to completion and the job's run shows its outcome.
2. **Migration.** For tasks with `parent_job_run_id` set, copy `job_runs.agent_run_id` into `parent_run_id` where that is null and the old row names an agent run, and copy `job_runs.job_id` into `parent_job_id` where that is null. Then drop `parent_job_run_id` (with `idx_agent_async_tasks_parent_job_run` and its foreign key) and the `job_runs` table (with `idx_job_runs_job`). Remove `jobRunsPostgres`, the field from the port, the types, the repository mapping and every caller.
   - Tests: a Postgres migration test seeds a `job_runs` row with an agent run, one without, tasks linked only through the old field, and a task that already has its own `parent_run_id` and `parent_job_id` plus an old-field link to a different row. After migration the first task holds the run and the job, the second holds the job, the third keeps its own links unchanged, and neither the table nor the column exists.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | One run link and one job link, and the old table removed | Every background-task start path (command, slow tool call, subagent; IPC and inline lanes) sets `parentRunId` to the starting agent run and `parentJobId` to the job when there is one. The duplicate field and the `job_runs` table go, with a migration that carries their links over first. | 1, 2 | `apps/core/src/jobs/ipc-agent-task-lifecycle-handlers.ts`, `apps/core/src/jobs/async-mcp-tool-task.ts`, `apps/core/src/jobs/ipc-delegated-agent-execution.ts`, `apps/core/src/jobs/async-command-task-service.ts`, `apps/core/src/jobs/async-command-task-types.ts`, `apps/core/src/jobs/async-delegated-agent-task.ts`, `apps/core/src/app/bootstrap/inline-agent-task-lifecycle.ts`, `apps/core/src/application/core-tools/task-lifecycle.ts`, `apps/core/src/domain/ports/async-tasks.ts`, `apps/core/src/adapters/storage/postgres/repositories/async-task-repository.postgres.ts`, `apps/core/src/adapters/storage/postgres/schema/async-tasks.ts`, `apps/core/src/adapters/storage/postgres/schema/jobs.ts`, `apps/core/src/adapters/storage/postgres/schema/migrations/**`, the unit tests that name the removed field, `apps/core/test/integration/job-background-work.postgres.integration.test.ts`, `apps/core/test/integration/job-runs-removal-migration.postgres.integration.test.ts`, `apps/core/test/e2e/job-background-work.postgres.e2e.test.ts` | Postgres integration: job-started command, slow tool call and subagent saved with both links and reaching their outcome; chat case without a job link. Postgres migration test for the carry-over and drops. End-to-end `job-background-work`. | | yes |

New moving parts: none

## Notes
