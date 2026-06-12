# Multi-Worker Job Execution

Safe multi-worker job execution: leases, fencing, durable interactions, and
cluster-wide concurrency, introduced ahead of live chat.

## Schema

All tables live in Postgres (`apps/core/src/adapters/storage/postgres/schema/worker-coordination.ts`,
migration `0075_multi_worker_execution.sql`):

- `worker_instances` — worker identity: image digest, boot nonce, version,
  capabilities, status, heartbeat/last-seen timestamps.
- `run_leases` — one row per claim attempt: run id, job id, worker instance,
  lease token, monotonic fencing version, status
  (`active|expired|released|completed|failed`), claimed/expires/heartbeat
  timestamps. Partial unique indexes enforce a single active lease per run and
  per job.
- `run_slots` — cluster-wide concurrency slots keyed by workspace/app/agent
  slot keys with expiry; replaces the process-local Map.
- `pending_interactions` — durable permission/question prompts with status,
  approver, expiry, callback route, and idempotency key.
- `runner_control_events` — append-only outbox; events are persisted before
  external exposure (`exposed_at` stamped by the control plane).
- `runner_control_nonces` — replay prevention with TTL.
- `transient_grants` — run-scoped grants bound to the active lease token;
  never durable authority.

## Worker claim protocol

1. The runtime registers a worker instance at scheduler startup
   (`apps/core/src/jobs/worker-identity.ts`) and heartbeats every 30s.
2. The scheduler creates runnable work; the worker claims execution.
   `claimDueRunStart` issues the run lease inside the same transaction that
   inserts the run and flips the job to `running`
   (`canonical-job-repository.postgres.ts`). The claim returns a lease token
   and fencing version; without a confirmed claim the worker does not execute.
3. Terminal writes are token-fenced: `settleRunLease` transitions the lease
   only when the caller's token is still the run's active lease. A stale
   worker whose run was recovered drops all terminal writes (including the
   failsafe path). Live-run `notified_at` evidence is stamped only when the
   caller presents the same lease token that settled the terminal run.

## Recovery

- Worker heartbeats lapse → `markStaleWorkersUnhealthy` flags the worker.
- Lease expiry lapse → `recoverExpiredRunLeases` expires only lapsed leases;
  live leases (including those of a previous incarnation of this process) are
  never released at startup.
- A retry claim gets a strictly higher fencing version (computed across the
  run's and job's lease history), so the old worker's token/version can never
  match again. Recovered retries notify:
  "Run recovered: previous worker lost its lease; Gantry safely retried this run."

## Live turns

Live interactive turns are durable and worker-routable; see
[live-horizontal-execution.md](./live-horizontal-execution.md) for the full
contract. Ownership of a live turn is keyed by the deterministic scope
`(appId, agentSessionId, conversationId, threadId)` and fenced by `run_leases`
(live leases carry `job_id = null`), exactly like jobs. Continuations, stops,
and prompt resolutions that land on a non-owner worker are appended to the
owning turn's durable command inbox instead of mutating process-local state.

Live execution is horizontally distributed (WP2): message polling, live-turn
admission, and owned-turn execution run on EVERY live-capable worker (role
`all`/`live-worker` with `runtime.live_turns.enabled`). The durable
one-active-turn-per-scope claim (`uq_live_turns_active_scope`) is the only
serialization point — a poller that loses the claim routes its message to the
owning turn's command inbox instead of starting a second run. To avoid orphan
`agent_run` rows under N pollers, admission does a cheap `getActiveLiveTurn`
pre-check before minting a run, and terminal-marks any run that loses the
residual claim race.

Each live worker bounds its own concurrency with a per-worker slot key
`live:messages:<workerInstanceId>` (capacity `runtime.queue.max_message_runs`);
in workstation mode the single worker is the only holder, so the bound is
identical to before.

The `runtime:live-recovery-coordinator:default` advisory lease elects a SINGLE
recovery coordinator. It no longer gates polling or admission — it gates only
startup pending-message recovery and the periodic recovery sweep. Recovered
turns resume on the coordinator under a strictly higher fencing version; if the
coordinator lacks slot capacity for a turn, that turn defers to the next sweep.
The `runtime.live_turns.enabled` flag remains the global rollout guard.

Provider inbound is single-flighted per connection: polling transports (e.g.
Telegram `getUpdates`) acquire a per-bot advisory lease
(`telegram:poll:<botTokenHash>`) so exactly one live worker long-polls a given
connection at a time, while the DB-persisted messages it ingests are admitted by
ANY live worker through the distributed polling loop. Push/webhook transports
(Slack Socket Mode, Teams SDK) need no such lease. Scheduler-only and control
workers set `providerInbound: false` and connect channels outbound-only, so they
never acquire inbound provider polling/socket leases.

## Permission durability

`pending_interactions` rows are created before a permission/question prompt
renders (`apps/core/src/application/interactions/pending-interaction-durability.ts`
wired into `apps/core/src/runtime/ipc-interaction-processing.ts`). Provider
callbacks resolve the
durable record. Persistent grants are committed to settings/Postgres before
the IPC response resumes the worker (pre-existing flow). Transient approvals
become `transient_grants` rows scoped to the active run lease.
Scheduled question prompts carry the same app/run/job/lease context as
scheduled permission prompts and are lease-checked before rendering and before
answer response delivery.

## Acceptance gates

Covered by
`apps/core/test/integration/worker-coordination.postgres.integration.test.ts`:
double-claim refusal, stale-worker fencing, fenced notification evidence, crash
releasing only expired leases, restart-surviving prompts, replayed-event
rejection, lease-scoped transient grants, cluster slot capacity/reclaim, and
worker health sweeps.
