---
slug: job-background-work-saves
title: Background work started by a job is saved and finishes
status: draft
saved: 2026-10-09T12:37:08+00:00
---

# Background work started by a job is saved and finishes

## Why

When a job starts background work (a long command, a slow tool call or a subagent), Gantry saves a task record for it. For a job, that record links to the job's run through a field whose database rule requires a matching row in an old job-results table (`job_runs`). Nothing has written to that table since job outcomes moved to the agent-runs table. So the link points nowhere, and saving the task fails. The same task in a chat links its run through a second field, which points at the agent-runs table and works.

- **Cost today:** a job can't hand anything off to the background, so it can't use background commands, slow tools or subagents. The subagents spec records no delegated or background task ever completing.
- **Two fields for one fact:** "which run started this task" lives in two fields, and the one jobs use points at a dead table. The architecture guides also named that table, and a review had to correct them.

## Behaviour

- **One run link.** Every background task records the run that started it in one field, which points at the agent-runs table. That is the same for chat turns and job runs. The job link (`parent_job_id`) stays, so a job's tasks are still found by job.
- **Jobs can start background work.** A background command, slow tool call or subagent started inside a job run is saved and runs to its outcome, as it does in chat.
- **The unused table and field are removed.** The old job-results table and the duplicate run-link field are dropped with a one-way migration, along with their index and database rule.

## Risks

- **One-way migration.** It drops the old job-results table and the duplicate field on background tasks. Nothing writes to the table today. A background-task row could only have a value in the duplicate field if a matching job-results row existed, so no saved link is lost.

## Acceptance criteria

- **AC1.** A background command, a slow tool call and a subagent each started inside a job run are saved and reach their outcome. A Postgres integration test proves this against the real schema.
- **AC2.** A background task records its starting run in one field for chat and jobs alike. The job-results table and the duplicate field no longer exist after migration.

## Success measure

- Metric: background tasks started by job runs that are saved, per week.
- Baseline: 0. Saving fails for every job-started task today.
- Target: every job-started background task in the first month after merge is saved, with no foreign-key failures in the logs.
- Check date: 2026-11-15

## Out of scope

- Subagent behaviour inside jobs (authority, budgets, cancellation when the job ends) stays with the subagents spec (SUB-2).

## Roadmap

- JOBRUNS-1: Background work started by a job is saved and finishes
