# 2026-06-12 — Process Roles and Multi-Live Execution

## Context

[2026-06-11 — Deployment Modes](./2026-06-11-deployment-modes.md) shipped the
fleet topology as a single autoscaled pool of identical workers with a singleton
**live-host lease** (`runtime:live-turn-host:default`) electing one worker to own
all live turns (ADR §4). That ADR §5 explicitly deferred the "Phase-4 multi-live
GroupQueue cutover" until one of two criteria fired:

1. live-turn throughput on a single live host saturates, or
2. an availability requirement sets failover RTO below the live-turn lease TTL.

Two pressures changed the decision:

- **Control-plane separation.** Running the full admin/settings API on every
  worker means every public-facing chat worker also exposes admin mutation
  routes. Operators want admin authority isolated from the internet-facing
  execution surface — a control plane that owns settings writes, with execution
  workers serving only operational/diagnostic routes.
- **Live-chat horizontal scale.** The single-live-host ceiling meant adding
  workers grew job/webhook capacity but **zero** chat capacity. The product
  decision is to make live chat scale horizontally now (superseding the §5
  "defer until saturation" criteria by product priority, not by hitting the
  saturation trigger).

These are the same one-binary, one-image constraints as before: no fork of the
runtime, both personal and fleet exercise the same application/domain contracts
([personal-and-enterprise-modes.md](../architecture/personal-and-enterprise-modes.md)).

## Decision

### 1. Process roles (deployment-owned env, not settings)

A new deployment-owned env var **`GANTRY_PROCESS_ROLE`** selects which fleet
service a runtime process behaves as. One image, many roles. Resolved once at
boot (`apps/core/src/app/bootstrap/roles/`); an unrecognised value **throws** —
a wrong-lane deployment env must fail loudly, not silently degrade.

| Role | controlApi | live exec | job exec | provider inbound | settings writes | bakes | registers as worker |
|---|---|---|---|---|---|---|---|
| `all` (default) | full | yes | yes | yes | yes | yes | yes |
| `control` | full | no | no | no | yes | no | **no** |
| `live-worker` | ops | yes | no | yes | no | no | yes |
| `job-worker` | ops | no | yes | no | no | yes | yes |

- `controlApi: full` mounts every control route (today's behaviour).
  `controlApi: ops` mounts only operational + read-only diagnostic routes
  (`/healthz`, `/readyz`, `/metrics`, and read-only `/v1/status`, `/v1/health`,
  `/v1/doctor`); every admin/mutation route 404s.
- **`all` is the workstation default** and behaves exactly as the historical
  single process — zero regression for workstation. Roles are a fleet concern.
- The role is **deployment lane, not desired state**: it is `GANTRY_PROCESS_ROLE`
  (set by Docker Compose / EC2 user_data / the orchestrator), **not** a
  `settings.yaml` key. It selects which subsystems boot; it is not part of the
  versioned settings document that workers converge on. This keeps it on the same
  axis as `GANTRY_SECURITY_POSTURE` (deployment env) and off the
  `runtime.deployment_mode` settings axis.

### 2. Control-plane separation

`control` runs the full admin/settings API and accepts settings desired-state
writes, but runs **no live or job execution, no bakes, no provider inbound**, and
**does not register as a `worker_instances` row** (it executes nothing). Worker
roles (`live-worker`, `job-worker`) serve **ops-only** API: admin mutation routes
404. This isolates admin authority from the public execution surface — control
plane owns policy decisions; workers are untrusted execution surfaces
(AGENTS.md "Control plane owns authority").

### 3. Multi-live cutover executed (supersedes 2026-06-11 §4/§5)

Live execution is now **horizontally distributed**. Message polling and durable
live-turn admission run on **every** live-capable worker (`all`/`live-worker`).
The serialization point is the durable one-active-turn-per-scope claim
(`uq_live_turns_active_scope`), not a lease on a host: a poller that loses the
claim routes its message to the owning turn's command inbox instead of starting a
second run.

- The singleton **live-host** lease `runtime:live-turn-host:default` is **gone**.
- A lease-elected **recovery coordinator** (`runtime:live-recovery-coordinator:default`)
  remains, owning **only** startup pending-message recovery and the periodic
  recovery sweep — nothing on the hot path. A standby that loses the election
  still polls, admits, and executes live turns; it just does not run the sweep.
  On drain the holder releases the lease early and any live worker can be elected;
  recovered turns resume on the coordinator under a strictly higher fencing
  version.
- **Per-worker slot capacity:** each live worker bounds its own concurrency with
  the slot key `live:messages:<workerInstanceId>` (capacity
  `runtime.queue.max_message_runs`). So `max_message_runs` is **per-live-worker**
  capacity in a fleet, and **adding live workers adds chat capacity linearly** —
  the old "adding workers adds zero chat capacity" ceiling is obsolete.
- Provider inbound stays single-consumer per connection where the transport
  requires it: polling transports (Telegram `getUpdates`) acquire a per-bot
  advisory lease (`telegram:poll:<botTokenHash>`); push transports (Slack Socket
  Mode, Teams SDK) need no lease. The messages ingested are admitted by **any**
  live worker through the distributed polling loop.

This supersedes [2026-06-11 — Deployment Modes](./2026-06-11-deployment-modes.md)
§4 (the "1 live-host + N job workers" topology and the singleton live-host lease)
and §5 (the Phase-4 deferral). The §5 criteria are no longer the trigger; the
cutover ships by product decision. The full runtime contract is
[live-horizontal-execution.md](../architecture/live-horizontal-execution.md) and
[multi-worker-execution.md](../architecture/multi-worker-execution.md).

### 4. Locked decisions carried forward (from the deployment-modes plan)

- **One image, many roles.** No per-role image build; the role is an env var read
  at boot.
- **No separate FastAPI control authority.** The control plane is the same Node
  runtime with `controlApi: full`; there is no second service/framework.
- **Subagents stay local.** Native SDK subagents execute inside their parent
  turn's runner process; the role split does not move them off-box.
- **Jobs stay on the scheduler lease path.** Scheduled job execution keeps using
  the existing `run_leases` + fencing claim protocol; the role split only changes
  which processes run the scheduler loop (`job-worker`/`all`).
- **Runtime events remain observable-only.** `runtime_events` are output, never a
  command bus; durable continuation/stop/prompt routing uses the live-turn
  command inbox.

## Alternatives Considered

- **Keep the singleton live-host lease and only add control separation.**
  Rejected: leaves the "adding workers adds zero chat capacity" ceiling in place,
  which was the core scaling complaint. The horizontal primitives
  (`live_turns` + `run_leases` fencing + command inbox) were already built in WP2,
  so the cutover is realizing existing work, not net-new risk.
- **Make the process role a `settings.yaml` key.** Rejected: a settings key is
  desired state that workers converge on at runtime; the role decides which
  subsystems a process boots, which must be fixed for the process lifetime and
  owned by the deployment lane. Mixing it into desired state invites a worker
  changing its own role mid-flight. Same reasoning that kept security posture an
  env var ([2026-06-11 — Deployment Modes](./2026-06-11-deployment-modes.md) §2).
- **Separate control image / FastAPI authority.** Rejected by the one-image rule;
  the existing control server already supports `full`/`ops` route profiles.

## Consequences

- Fleet Terraform splits into three pools (`control`, `live-worker`, `job-worker`)
  in `envs/fleet`; the ALB routes `/v1/*` to the control target group and
  `/webhooks/*` to the live target group. The minimal support stack stays a single
  `all`-role worker registered to both target groups.
- Local rehearsal compose splits the single `worker` service into `control`,
  `live-worker`, `job-worker`, scaled independently with
  `--scale live-worker=N --scale job-worker=M`.
- `worker_instances` gains `process_role` (migration 0078); `gantry workers list`
  shows it.
- `/readyz` gains a top-level `role` and role-specific checks; `/metrics` gains
  role and live-execution gauges; `/v1/health` gains `processRole`; `gantry
  status` shows the process role. (Observability contract; see
  deployment-profiles.md and the SDK docs.)
- Overload is durable, not a drop: inbound is accepted and persisted; past a
  waiting threshold the user sees "Still starting this request." (sent once per
  waiting episode by the recovery coordinator). Worker capacity language stays
  operator-only. Recovery keeps the existing "Run recovered: previous worker lost
  its lease; Gantry safely retried this run."

## Rollback Or Migration Notes

- No data migration beyond the additive `worker_instances.process_role` column
  (0078). Workstation is unaffected: `GANTRY_PROCESS_ROLE` defaults to `all`,
  which is the historical single-process behaviour.
- Reverting a fleet to a single pool is a Terraform change (run every pool as
  `all`, or collapse to one `all` pool) plus an image roll; no schema rollback.
  The horizontal live primitives are correct with one worker too (it is simply
  the only claimer).

## See Also

- [2026-06-11 — Deployment Modes](./2026-06-11-deployment-modes.md) (superseded
  §4/§5)
- [deployment-profiles.md](../architecture/deployment-profiles.md)
- [live-horizontal-execution.md](../architecture/live-horizontal-execution.md)
- [multi-worker-execution.md](../architecture/multi-worker-execution.md)
- [docs/deployment/aws-terraform.md](../deployment/aws-terraform.md)
