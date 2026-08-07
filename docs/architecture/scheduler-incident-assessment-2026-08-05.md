# Scheduler incident assessment — lead-maintenance pause loop (2026-08-05)

Source: runtime-agent diagnosis reviewed and adopted by Ravi (chat, 2026-08-05).
Program: stories SCHED-1..SCHED-5; decisions 0106-0109.

## Headline

The agent-owned durable permission model is correct and stays. The recurring
failure comes from four interacting mechanisms:

1. A scheduled run can edit its own future job definition.
2. Scheduler mutations auto-approve in normal auto mode despite decision 0058
   recording them as human-gated.
3. Automatic allow_once decisions are mistaken for human temporary consent,
   pausing recurring jobs after successful runs.
4. Finalization uses the job definition captured before execution and can
   overwrite changes made during the run.

Likely incident path: the scheduled run saw raw durable rules (no capability
catalog), chose a raw gog/Sheets shell path, called scheduler_update_job to
put that command into access_requirements, readiness failed on it (job paused,
next_run cleared), and the auto-allowed scheduler_update_job itself was read
by the finalizer as human one-time consent — pausing the job again on the
next loop. No host mechanism auto-appends observed commands to requirements;
requirement changes flow through explicit scheduler mutations.

## Confirmed problems

### 1. High — scheduled workloads edit their own control plane (SCHED-1, 0106)

Scheduled runners receive all scheduler tools (shared/admin-mcp-tools.ts,
runner/gantry-mcp-tool-surface.ts); scheduler_update_job can replace the whole
requirement list (runner/mcp/tools/scheduler.ts, jobs/ipc-scheduler-mutate-
handlers.ts); the scheduled prompt encourages self-editing (anthropic runner
index.ts). Decision 0058 explicitly kept every scheduler mutation outside
birthright because it affects future unattended execution. Fix: scheduled
runs get read tools only; structured proposedJobChange output; signed
sourceJobId/sourceRunId/sourceRunKind on scheduler IPC with host-side
rejection of scheduled-source mutations (writeIpcFile and
submitSchedulerMutationTask currently carry no source identity).

### 2. High — scheduler mutations auto-approve (SCHED-1, 0107)

Mutations sit in the grantable medium-risk bucket (gantry-tool-risk.ts) and
auto-allow in normal auto mode; tests REQUIRE that behavior
(gantry-tool-risk.test.ts, permission-classifier.test.ts) in direct conflict
with 0058 (0065 widened persistent-grant buttons but not auto-allow). Fix:
reads low/birthright; mutations and delete high/ask; correct the tests.

### 3. High — automatic allow_once read as human temporary consent (SCHED-1, 0107)

execution-diagnostics.ts marks any successful allow_once not decided_by
reviewed_rule as transient; execution-finalization.ts pauses every recurring
job with such an entry. But auto_classifier, cached_classifier_verdict,
trusted_root_grant, birthright and deterministic rails all emit allow_once —
it is invocation lifetime, not intent — and domain/permission-decision.ts
labels every allow_once user_temporary. Fix: typed provenance
(source + repeatable-for-future-runs); pause only on explicit human one-time
consent; regression cases per source.

### 4. High — finalization overwrites concurrent edits (SCHED-3, 0108)

computeNextJobRun uses the pre-execution job snapshot; the terminal update
fences on the run lease only (canonical-job-repository.postgres.ts) — no
definition revision exists in the schema. Human pause/schedule/requirement
changes during a run are overwritten; the finalizer can reactivate a paused
job. Fix: definition_revision + revision-aware terminal reconciliation.

### 5. Medium — scheduled runs lack the capability catalog (SCHED-4)

Interactive runs resolve and render a prompt capability catalog
(group-agent-access-context.ts → agent-spawn-prompt.ts); scheduled execution
resolves policy/skills/MCP/capabilities but never passes capabilityCatalog
(jobs/execution.ts) and leads with raw rules — nudging models toward shell
paths. Fix: reuse the interactive resolver; show ready actions first.

### 6. Medium — competing requirement representations (SCHED-5, 0109)

Semantic capability, raw rule, MCP server and implementation-bearing
capability entries dedupe independently (job-access-requirements.ts), so
capability and raw-command versions of the same dependency coexist. Fix:
capability IDs canonical; raw commands escape-hatch-only; migration.

### 7. Medium — causality not provable (SCHED-4)

No job.definition_changed / status_transition / readiness_changed events
(runtime-event-types.ts); mutation receipts say only "job updated"; event
formatters drop permission provenance. Fix: immutable definition-change and
transition events with actor, source run, revision, before/after and reason
codes; richer receipts and rendering.

### 8. Medium — completed without the business effect (SCHED-4)

Runner outcome is success|error + prose; "completed with issues" is a
formatting heuristic (status-formatting.ts); found-2-written-0 records as
completed. Fix: structured completed|partial|blocked outcome with counts,
effects and blocker (worker responseSchema support is a bounded prerequisite —
agent-spawn-admission.ts currently rejects it in the worker lane).

### 9. Low — paused-job recovery caps at 100 (SCHED-4)

job-permission-recovery.ts loads limit:100; paginate until drained.

## Ownership model (target)

Agents own authority. Jobs declare semantic dependencies. Runs consume an
immutable snapshot and may PROPOSE changes but cannot alter future unattended
execution. The scheduler alone owns readiness, timing, lease and status —
through one reconciler. Explicit non-goals: job-local permission grants, a
second permission store, broad raw-command authority, automatic self-resume,
auto-promoting observed tool use into requirements, new wrapper abstractions
over the capability catalog.

## Execution order

1. SCHED-1 — the four correctness blockers, shipped together (provenance
   classification, mutation tools off scheduled surfaces, ask-gated
   mutations, signed source provenance with host rejection).
2. SCHED-2 — attended repair of the live lead job (semantic Sheets
   dependency, prompt rewrite, readiness check, single resume, idempotent
   replay of the two missed writes).
3. SCHED-3 — definition_revision + revision-aware finalization.
4. SCHED-4 — events/receipts/rendering, capability catalog + runtime brief in
   scheduled prompts, structured outcomes, recovery pagination.
5. SCHED-5 — semantic capability IDs canonical + migration.

## Required regression suite (acceptance backbone)

- Provenance: recurring job stays active after auto_classifier /
  cached_classifier_verdict / trusted_root_grant / birthright /
  deterministic_read_only / reviewed_rule allows; pauses only on explicit
  human allow_once.
- Mutation authority: scheduled runs do not mount mutation tools; forged
  scheduled-source mutation IPC is host-rejected; interactive mutations ask
  in auto mode; reads stay unprompted; a job cannot pause/resume/delete/run/
  update itself.
- Concurrency: human pause mid-run stays paused; mid-run schedule change
  yields next_run from the new schedule; requirement edits survive; revision
  conflicts reconcile, never blind-write.
- Semantic use: the Sheets capability passes readiness and executes without a
  raw job RunCommand; equivalent raw commands are rejected/canonicalized; the
  scheduled prompt lists the ready action.
- Auditability: definition changes and transitions carry actor/source-run/
  revision/reason and render in scheduler tools.
- Outcome: found-2-written-0 is partial/blocked, never plain completed.

## Addendum (2026-08-05, Ravi): notification & approval UX spec

Six defects in how the incident presented, priority-ordered (2 and 4 are the
cheap wins, 5 removes the misdiagnosis, 1/3/6 are polish → SCHED-4A carries
2/4/5/3; SCHED-4 carries 1/6):

1. Setup-needed messages must say what broke, not just what is missing:
   human-readable action, the job step that triggered it, died-vs-degraded,
   and the scope choice — never a bare tool id.
2. One-time vs durable must be explicit: approval prompts offer scope
   (read-only defaults durable), and an Allow-once confirmation says
   "Approved for this run only. It will ask again next run."
3. Repeats escalate the copy: "Asked 3 times in 9 days, each approved once
   only. Approve permanently?"
4. Never send Setup-needed and Completed as contradictory peer cards: fold
   the blocker into "Completed with limits" + degraded line, or badge it.
5. Distinguish "not granted" from "granted but the command shape did not
   match the rule": show approved pattern vs attempted command.
6. Job health names the specific gap as the computed declared-vs-granted
   diff ("missing: memory_search — declared by job, not granted to agent"),
   not a bare missing_capability state.
