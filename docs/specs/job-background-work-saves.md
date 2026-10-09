---
slug: job-background-work-saves
title: Background work started by a job is saved and finishes
status: confirmed
saved: 2026-10-09T12:37:08+00:00
confirmed_by: "Ravi"
confirmed_hash: 4eb71f3b2fbb8e412fa80ead8c7cac408a2cf3dcdf0a35ae7d45f85bc387befc
---

# Background work started by a job is saved and finishes

## Why

When a job starts background work, Gantry saves a task record that should say which run and which job started it. Today that goes wrong in two ways:

- **Background commands and slow tool calls started by a job fail to save.** Their record links to the job's run through a field whose database rule requires a matching row in an old job-results table (`job_runs`). Nothing has written to that table since job outcomes moved to the agent-runs table, so the link points nowhere and the save fails. The same task in a chat links its run through a second field that points at the agent-runs table, and works.
- **Subagents started by a job save without their links.** The subagent path clears the run link for jobs and passes no job link, so the record can't be traced back to the job or run that started it.

**Cost today:** a job can't run background commands or slow tools, and its subagents can't be found by job or run, which job cancellation and recovery need. "Which run started this task" also lives in two fields, and the one jobs use points at a dead table. The architecture guides also named that table, and a review had to correct them.

## Behaviour

- **One run link.** Every background task (command, slow tool call or subagent) records the run that started it in one field, which points at the agent-runs table. That is the same for chat turns and job runs.
- **One job link.** A background task started inside a job also records that job, whatever its kind, so a job's tasks are found by job.
- **Jobs can start background work.** A background command, slow tool call or subagent started inside a job run is saved with both links and runs to its outcome, as it does in chat.
- **The unused table and field are removed.** A one-way migration first carries over what the duplicate field points at, for tasks that don't already have it: the old row's agent run becomes the task's run link, and its job becomes the task's job link. An old row with no agent run never had a run to point at, so its task keeps only the job link. The migration then drops the duplicate field, its index and database rule, and the old job-results table.

## Risks

- **One-way migration that deletes the old job-results table.** Its rows, if any, are history from before job outcomes moved to the agent-runs table, and nothing reads them. The only data that refers to them, a background task's duplicate run link, is carried over before the drop: to the one run link when the old row names an agent run, and to the job link in every case. So no task loses its run or its job; an old row without an agent run had no run to keep.

## Acceptance criteria

- **AC1.** A background command, a slow tool call and a subagent, each started inside a job run through the production job dispatch, are saved and reach their outcome, and each saved record holds the starting run and the job. A Postgres integration test proves this against the real schema.
- **AC2.** A background task records its starting run in one field for chat and jobs alike. After migration the old job-results table and the duplicate field no longer exist, and a Postgres migration test shows that a task linked only through the duplicate field keeps its run in the one run link when the old row names one, and keeps its job link in every case, including an old row with no agent run.

## Success measure

- Metric: share of background tasks started by job runs each week that are saved with both their run and job links.
- Baseline: 0. Job-started commands and slow tool calls fail to save, and job-started subagents save without either link.
- Target: 100% in each week of the first month after merge, with no foreign-key failures in the logs.
- Check date: 2026-11-15

## Out of scope

- Subagent behaviour inside jobs (authority, budgets, cancellation when the job ends) stays with the subagents spec (SUB-2).

## Roadmap

- JOBRUNS-1: Background work started by a job is saved and finishes
