---
reader: codex (gpt-6.1-sol)
read_at: 2026-10-09T13:48:02+00:00
read_hash: bfcb8183d198e59d359acc7bb250524437fcd7e8
round: 3
passed: yes
doc_seen: bfcb8183d198e59d359acc7bb250524437fcd7e8
spec_seen: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
notes_seen: bd7795e9de83ec409daa1e4549da181c5cc11366
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc, then run
`forge read <doc>` again for the next round, until a round finds nothing:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options.

## Round 1

1. The migration’s “no saved link is lost” claim does not follow from the foreign key.
   A matching `job_runs` row permits a populated parent link; no current writer does not prove historical rows are absent. Pin a fail-closed rule before deletion: refuse migration if data requiring preservation exists. Add a populated-upgrade test proving refusal leaves that data intact.
   Disposition: keep, amended: the migration carries any duplicate run link into the one run link through job_runs.agent_run_id before the drop, proven by a populated migration test (AC2); old job_runs rows are unread pre-cutover history and their deletion is the named one-way step (no legacy support, so no refusal path).

2. Unproven: item 2 (AC2): saving and completing a subagent does not prove its job/run linkage.
   `ipc-delegated-agent-execution.ts:54` explicitly clears `parentRunId` for jobs, and delegated admission supplies no `parentJobId`. This path can save and complete without hitting the broken foreign key, contradicting the blanket failure baseline. Extend AC1’s same Postgres test through production job-origin dispatch and assert the persisted starting-run and job links.
   Read-only review; no files changed. Runtime execution and existing database contents were not checked.
   Disposition: keep, amended: Why and the baseline now separate commands and slow tools (fail to save) from subagents (save without links); Behaviour adds one job link for every kind; AC1 proves all three kinds through production job dispatch with both links persisted.

## Round 2

3. Disputed keep 1: the backfill cannot preserve every existing link because `job_runs.agent_run_id` is nullable.
   `schema/jobs.ts:120` permits a referenced job-results row with no agent-run pointer. A task linked only to that row would receive a null run link, then lose its original link during the drop; AC2’s successful-backfill test would still pass. Pin refusal before deletion when a duplicate-only link cannot resolve to an agent run, and prove refusal preserves the data in the migration test.
   No files changed or database checks run; this data-loss case is permitted by the schema.
   Disposition: keep, amended: the backfill also carries the old row's job into the job link for every duplicate-only task, so a run-less row loses nothing it had (it never named an agent run); AC2's migration test now covers that case. No refusal path: the product carries no legacy support.

## Round 3

No findings.
