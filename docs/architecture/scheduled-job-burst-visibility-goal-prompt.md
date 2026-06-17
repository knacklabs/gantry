# Scheduled Job Burst Visibility Goal Prompt

> Status: next goal prompt.
>
> Use this after the current Postgres/live-latency goal when the next highest
> risk is multiple scheduled jobs becoming due in the same workspace at the
> same time.

```text
/goal Make Gantry's same-workspace scheduled-job burst behavior visible and deterministic when multiple jobs become due at the same time, without changing scheduler ownership, leases, capability authority, or provider architecture.

This is an implementation goal. Make code, tests, docs, and verification changes as needed. Do not stop at a design summary. Start by converting this prompt into acceptance criteria and a capability-driven task decomposition before editing.

Product model:
- Jobs are runtime Postgres state, not `settings.yaml` desired state.
- Scheduler execution continues to use pg-boss delivery plus Gantry-owned Postgres `run_slots`, worker claims, run leases, and fenced terminal writes.
- Capacity wait is normal backpressure, not a failure, permission blocker, setup blocker, or new authority state.
- `execution_context` and `notification_routes` remain the canonical job targeting and delivery contract.
- `runtime_events` stay observable-only and must not become command authority.

Primary decision:
- Do not rewrite the scheduler for this goal.
- Do not add Redis, SQS, Kafka, Redis Streams, a queue-provider selector, a cache provider, or a broker selector.
- Do not change `settings.yaml`.
- Do not change job capability grants, selected tools, sender policy, approvers, or notification route authority.
- Reuse the existing pg-boss plus Postgres run-slot path and add the smallest durable or derived visibility signal needed to explain capacity waits.
- Prefer deriving the visible state from existing runtime data. Add a narrow persisted signal only if derivation cannot be correct across workers and restarts.

Mandatory repo truth before edits:
- `README.md`
- `WORKFLOW.md`
- `docs/FACTORY.md`
- `docs/QUALITY.md`
- `docs/architecture/current-verification-commands.md`
- `docs/architecture/autonomous-jobs.md`
- `docs/architecture/capability-management.md`
- `docs/architecture/multi-worker-execution.md`
- `apps/core/src/jobs/scheduler.ts`
- `apps/core/src/jobs/concurrency.ts`
- `apps/core/src/infrastructure/pgboss/scheduler-engine.ts`
- `apps/core/src/adapters/storage/postgres/repositories/worker-coordination-repository.postgres.ts`
- `apps/core/src/application/jobs/job-visibility-metadata.ts`
- `apps/core/src/runner/mcp/tools/scheduler-formatters.ts`
- `apps/core/test/unit/runtime/task-scheduler-pgboss.test.ts`
- `apps/core/test/unit/jobs/concurrency.test.ts`
- `apps/core/test/unit/application/job-visibility-metadata.test.ts`
- `apps/core/test/unit/runner/mcp/scheduler-tools.test.ts`
- `apps/core/test/integration/worker-coordination.postgres.integration.test.ts`

Known current behavior to verify:
- pg-boss local worker concurrency is controlled by `runtime.queue.maxJobRuns`.
- Each due delivery attempts `tryAcquireRunSlot(current.workspace_key)`.
- When a workspace run slot is unavailable, the delivery is requeued with a short jitter and `runJob` is skipped.
- The waiting job does not claim a `JobRun`, does not create a run lease, does not consume retry budget, and currently has no user-visible health state for the capacity wait.
- Users can see the already-running job as `running` while the waiting job may still look `ready` or eventually `missed_window`.

Exact UX contract:
- Add one canonical visible health state: `waiting_on_capacity`.
- Meaning: the job is due or runnable, but another job in the same workspace currently owns the run slot.
- Detail copy: `Health: waiting_on_capacity | action Waiting for another job in this workspace to finish.`
- List copy: `Next: Waiting for workspace capacity`.
- Do not use failure-oriented copy such as "stuck", "failed", "dead letter", "retrying", or "blocked" for normal capacity wait.
- No user action is required while only capacity is the reason for waiting.
- Existing setup, permission, timeout, stale lease, dead-letter, and missed-window states must keep their stronger meanings when they apply.

Acceptance criteria:
1. Given two scheduled jobs due at the same time with the same `workspace_key` and workspace capacity 1, one job runs and the other is requeued without claiming a run.
2. While the second job is requeued because capacity is full, job list/detail visibility reports `health.state === "waiting_on_capacity"`.
3. The visible next action says the job is waiting for another job in the workspace to finish and requires no user action.
4. When the waiting job later acquires a slot, the capacity-wait signal clears and the job reports `running` during execution.
5. Capacity waiting does not increment retry budget, mark the job failed, pause the job, create setup metadata, request capability approval, or change notification route authority.
6. Different `workspace_key` jobs still run concurrently when global worker capacity allows it and do not show `waiting_on_capacity` for each other.
7. Stale capacity-wait markers cannot leave an idle job permanently showing `waiting_on_capacity` after the slot is free or the queued delivery is gone.
8. Manual run-now collisions may reuse the same visibility path only if the implementation is natural and small; otherwise document that collision handling is a follow-up, not part of this goal.

Capability-driven task decomposition:
1. Capacity-wait evidence:
   - Locate the smallest source of truth for "due job requeued because workspace slot is full".
   - Prefer a bounded operational signal tied to job id, workspace key, and expiry/next attempt time.
   - Clear or expire the signal when the job starts, is disabled, is deleted, misses its window, or no longer waits on capacity.
   - Tests: capacity-blocked delivery records visible wait evidence and skips `runJob`.
2. Job health derivation:
   - Add `waiting_on_capacity` to job visibility metadata only after setup/permission/terminal states are considered.
   - Ensure stale capacity evidence cannot outrank a real blocker or terminal state.
   - Tests: health derivation for waiting, cleared, stale, setup-blocked, permission-blocked, and missed-window cases.
3. MCP/API/CLI rendering:
   - Surface the state through scheduler list/detail summaries and any typed DTOs already exposing job health.
   - Keep wording channel-neutral and action-oriented.
   - Tests: scheduler MCP formatter/list output includes `waiting_on_capacity` and the workspace-capacity next action.
4. Runtime and Postgres correctness:
   - If a schema change is needed, add the narrowest runtime-state column/table/index and explain why existing metadata cannot safely represent the signal.
   - If no schema change is needed, document the derivation source and expiry rules.
   - Tests: existing run-slot capacity and reclaim integration coverage remains valid; add Postgres coverage only if persistence changes.
5. Docs and cleanup:
   - Update `docs/architecture/autonomous-jobs.md` with the new health state and exact meaning.
   - Search for old assumptions that capacity waits are invisible, retries, failures, setup blockers, or permission blockers.

Surface Impact Matrix:
- Runtime behavior: Changed. Same-workspace capacity waits become visible while preserving existing run-slot execution.
- `settings.yaml`: Unchanged by design. Job burst visibility is runtime state, not desired configuration.
- Postgres/runtime projection: Changed if a narrow capacity-wait signal is persisted; otherwise read-only/observable through existing runtime rows.
- Control API: Changed if job health DTOs include the new `waiting_on_capacity` value; otherwise read-only/observable.
- SDK/contracts: Changed only if SDK-exported job health types enumerate states.
- CLI: Changed if job list/detail commands render health or next action.
- Gantry MCP tools/admin skill: Changed. Scheduler list/get summaries must show the new capacity-wait state.
- Channel/provider adapters: Unchanged by design. This is scheduler visibility, not channel delivery behavior.
- Docs/prompts: Changed. Update autonomous jobs docs and this goal only as needed.
- Audit/events: Read-only/observable unless the chosen implementation emits a bounded runtime event for capacity wait evidence.
- Tests/verification: Changed. Add focused scheduler, visibility, and formatter coverage.

Required verification:
- `npm run test:unit -- apps/core/test/unit/runtime/task-scheduler-pgboss.test.ts apps/core/test/unit/application/job-visibility-metadata.test.ts apps/core/test/unit/runner/mcp/scheduler-tools.test.ts`
- `npm run test:unit -- apps/core/test/unit/jobs/concurrency.test.ts` if run-slot behavior or types change.
- `npm run test:integration -- apps/core/test/integration/worker-coordination.postgres.integration.test.ts` if run-slot persistence, schema, or reclaim behavior changes.
- `npm run build`
- `python3 .codex/scripts/verify.py`
- Run `autoreview` after implementation, tests, cleanup searches, and verification.
- Run `ponytail` after `autoreview` and fix any accepted simplification findings.

Required cleanup searches:
- `rg -n "waiting_on_capacity|waiting for workspace capacity|workspace capacity|run slot|run_slots" apps/core/src apps/core/test docs`
- `rg -n "retry budget|dead_lettered|missed_window|needs_permission|setup_required" apps/core/src/application/jobs apps/core/src/infrastructure/pgboss apps/core/test docs/architecture/autonomous-jobs.md`
- `rg -n "Redis|redis|SQS|sqs|Kafka|kafka|Redis Streams|queue provider|broker selector|cache provider" apps/core/src apps/core/test docs`
- `rg -n "execution_context|notification_routes|workspace_key" apps/core/src/application/jobs apps/core/src/infrastructure/pgboss apps/core/src/runner/mcp/tools apps/core/test`

Final handoff must include:
- Before/after behavior table for two due jobs in one workspace.
- Same-workspace versus different-workspace concurrency evidence.
- Exact storage decision: derived state or persisted narrow signal, with expiry/cleanup rules.
- User-visible copy and DTO/API changes, if any.
- Confirmation that capability authority, `execution_context`, `notification_routes`, and `settings.yaml` did not change.
- Cleanup search results and interpretation.
- Verification commands and results.
- `autoreview` result.
- `ponytail` result.

Definition of done:
- Gantry no longer makes same-workspace scheduled-job bursts look idle or mysteriously late.
- A waiting job visibly reports `waiting_on_capacity`, starts when workspace capacity frees, and never consumes retry/failure/setup/permission semantics for normal backpressure.
- The implementation stays on the existing pg-boss plus Postgres run-slot architecture with no new broker/cache/provider dependency.
```
