# Deployment Profiles

Operator-facing reference for the three ways Gantry's single binary is deployed:
**workstation**, **fleet**, and the **locked support stack** (a fleet variant).
This doc is the operator view; the decisions behind it are the ADRs:

- [Process Roles and Multi-Live](../decisions/2026-06-12-process-roles-and-multi-live.md)
  — the `GANTRY_PROCESS_ROLE` deployment env; control-plane separation; the
  multi-live cutover (live execution scales horizontally now). **This supersedes
  the single-live-host topology in the deployment-modes ADR.**
- [Deployment Modes](../decisions/2026-06-11-deployment-modes.md) — the
  `runtime.deployment_mode` key; topology vs security-posture axes (§4/§5 on the
  single live host are superseded by the process-roles ADR above).
- [Capability Artifacts](../decisions/2026-06-11-capability-artifacts.md) — skills
  and toolchains as current-state S3 artifacts + sandboxed bake jobs.
- [Settings Authority](../decisions/2026-06-11-settings-authority.md) — one
  desired-state service, two surfaces (YAML watcher vs control API).
- [Locked Preset](../decisions/2026-06-11-locked-preset.md) — `access.preset:
locked`, parent-side enforcement, isolation tiers.
- [Delivery Vehicle](../decisions/2026-06-11-delivery-vehicle.md) — Terraform/
  AWS-first.

Note: "profile" in this doc's title is operator vocabulary for the deployment
shape. The runtime **setting** is `runtime.deployment_mode` (`workstation|fleet`)
— it is **not** named "profile", which is reserved for agent persona tooling. See
[Deployment Modes](../decisions/2026-06-11-deployment-modes.md).

## Architecture Sketch (Fleet)

One image, differentiated by `GANTRY_PROCESS_ROLE` into three pools. The ALB
routes `/v1/*` (admin/API, SDK sessions, external ingress) to the control pool
and `/webhooks/*` (provider inbound webhooks) to the live pool. Job workers take
no ALB traffic.

```
  Slack/Teams/TG     ┌──────────────────────────────────────────┐
  webhooks ─────────►│        ALB (path-routed listener)        │
  API / SDK / SSE ──►│  /v1/* → control TG   /webhooks/* → live  │
                     └───────┬───────────────────────┬──────────┘
            ┌────────────────┘                       └───────────────┐
            ▼                                                         ▼
   ┌─────────────────┐                       ┌───────────────────────────────────┐
   │ control pool    │                       │ live-worker pool (autoscaled, ≥2)  │
   │ admin/settings  │                       │ ┌──────────┐ ┌──────────┐  ...     │
   │ API; no exec;   │                       │ │ live wkr │ │ live wkr │          │
   │ not a worker    │                       │ └────┬─────┘ └────┬─────┘          │
   └────────┬────────┘   distributed live    │      │ claim+admit every worker;  │
            │            admission/execution └──────┼──────────────┼─────────────┘
            │                                       │              │
            │      ┌────────────────────────────────┘              │
            │      │   job-worker pool (autoscaled): scheduler + bakes; no ALB
            │      │   ┌──────────┐ ┌──────────┐                    │
            │      │   │ job wkr  │ │ job wkr  │  ...                │
            │      │   └────┬─────┘ └────┬─────┘                    │
            │      │        │            │                          │
            ▼      ▼        ▼            ▼                          ▼
       leases / slots / live_turns / live_turn_commands / settings_revisions
            └──────────────────┬──────────────────┬────────────────┘
                               ▼                  ▼
                    ┌─────────────────┐   ┌──────────────────────┐
                    │ RDS Postgres    │   │ S3 artifact store    │
                    │ (pgvector)+Proxy│   │ skills/ toolchains/  │
                    └─────────────────┘   │ (bake:rw, worker:ro) │
                                          └──────────────────────┘
```

Live execution is horizontal: **every** live worker claims durable live-admission
work and admits live turns; the durable one-active-turn-per-scope claim is the
only serialization point. A lease-elected **recovery coordinator** owns only
startup pending-message recovery and the periodic recovery sweep — not the hot
path. See [live-horizontal-execution.md](./live-horizontal-execution.md).

## Process Roles

One image runs as differentiated fleet services, selected by the
**deployment-owned** env var `GANTRY_PROCESS_ROLE` (read once at boot; an invalid
value throws). This is **not** a `settings.yaml` key — it is the deployment lane
(same axis as `GANTRY_SECURITY_POSTURE`), and it selects which subsystems a
process boots. The workstation default is `all`.

| Role                        | Control API | Live exec | Job exec | Provider inbound | Settings writes | Bakes | Registers as worker |
| --------------------------- | ----------- | --------- | -------- | ---------------- | --------------- | ----- | ------------------- |
| `all` (workstation default) | full        | yes       | yes      | yes              | yes             | yes   | yes                 |
| `control`                   | full        | no        | no       | no               | yes             | no    | **no**              |
| `live-worker`               | ops-only    | yes       | no       | yes              | no              | no    | yes                 |
| `job-worker`                | ops-only    | no        | yes      | no               | no              | yes   | yes                 |

- **`full` control API** mounts every route (today's behaviour). **`ops-only`**
  mounts only `/healthz`, `/readyz`, `/metrics`, and the read-only `/v1/status`,
  `/v1/health`, `/v1/doctor`; every admin/mutation route 404s.
- **`control`** owns admin authority and settings writes, runs no execution, and
  does not register as a `worker_instances` row (it executes nothing). Channels
  connect outbound-only.
- **`live-worker`** runs distributed live admission/execution + provider inbound
  - chat delivery. No scheduler, no bakes.
- **`job-worker`** runs the scheduler + bakes + job-notification delivery.
  Channels outbound-only; no live admission, no provider inbound.
- **`all`** is everything in one process — the workstation and minimal
  support-stack shape; zero regression from the historical single process.

`worker_instances.process_role` (migration 0078) records the role of each
registered worker; `gantry workers list` shows it (`control` never appears — it
does not register).

## Mode Matrix

| Concern             | Workstation                                             | Fleet                                                                                                                                                                                                                                                | Locked Support Stack                                                   |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Topology            | Single machine (`all` role), vertical scale             | Three role pools behind one ALB — `control` (admin/API), `live-worker` (distributed live exec), `job-worker` (scheduler + bakes); all from one image via `GANTRY_PROCESS_ROLE`                                                                       | Single `all`-role worker (one box does everything); locked agents only |
| Scaling             | None (one host)                                         | `live-worker` scales out for chat capacity; `job-worker` scales out for job/bake load; both on CPU target tracking. `control` is usually a single box                                                                                                | Vertical only (`worker_instance_type`); one box                        |
| Capability installs | Live on host (package manager runs)                     | Artifacts in S3, replace-on-update; sandboxed bake job; **no package manager on workers**                                                                                                                                                            | Pre-provisioned only; no live install, no escalation                   |
| Settings surface    | `settings.yaml` watcher imports to `settings_revisions` | Control-API desired-state CRUD; `settings_revisions` + pg_notify; YAML is bootstrap/backup only                                                                                                                                                      | Same as fleet                                                          |
| Live-turn topology  | In-process                                              | **Distributed**: every `live-worker` polls + admits; the durable one-active-turn-per-scope claim serializes ownership; a lease-elected recovery coordinator owns only startup recovery + the periodic sweep. Chat capacity scales with the live pool | Single `all` worker is the only claimer; identical primitives          |
| Security posture    | Relaxed local (may opt into production)                 | **Production required**                                                                                                                                                                                                                              | **Production required**                                                |
| Agent access preset | `full` (default)                                        | `full` or `locked` per agent                                                                                                                                                                                                                         | `locked`                                                               |
| Delivery            | Local run                                               | Terraform/AWS (`envs/fleet`)                                                                                                                                                                                                                         | Terraform/AWS (`envs/support`)                                         |
| Isolation           | n/a                                                     | Per-tenant stack                                                                                                                                                                                                                                     | Isolated stack (default) or co-tenant (cheaper, weaker blast radius)   |

## State-Ownership Table

Where each piece of state lives, per mode. "—" means not applicable in that mode.

| State                                    | Workstation                                                                          | Fleet / Locked                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desired settings (canonical)             | Postgres `settings_revisions`; `settings.yaml` = synced copy + watched import/export | Postgres `settings_revisions` via control API; `settings.yaml` = bootstrap/backup                                                                                  |
| Secrets / channel credentials            | Runtime secret refs: `gantry-secret:` encrypted rows by guided setup, plus optional `env:` or `aws-sm:` refs | Same runtime secret refs; AWS Secrets Manager is optional, and no secret values belong in Terraform state                                          |
| Skill source bytes                       | Local `skills/<name>/` on host disk                                                  | **S3** `skills/` (current-state artifact, sha256-verified)                                                                                                         |
| Dependency toolchains                    | Installed live on host                                                               | **S3** `toolchains/` (bake-job output, current-state artifact)                                                                                                     |
| Runtime/runs/leases/slots/turns/commands | Postgres                                                                             | Postgres (RDS + Proxy)                                                                                                                                             |
| Worker capability advertisement          | n/a (single host)                                                                    | Postgres `worker_instances.capabilities_json`                                                                                                                      |
| Activated artifact on a worker           | Host disk                                                                            | **Worker disk** (ephemeral cache; re-fetched/verified from S3, atomic temp-write + rename)                                                                         |
| Browser profiles                         | Host disk                                                                            | Worker disk + durable cross-worker snapshot store (`browser-profiles/` prefix); snapshot on turn end → restore on launch, atomic + sha-verified (see Browser Note) |
| Audit / provenance                       | Postgres audit events                                                                | Postgres audit events                                                                                                                                              |

## Upgrade / Skew Matrix

Rolling deploys mix old and new workers, old and new settings revisions, and old
and new artifacts. Each row is a skew scenario with the expected behavior and the
operator-visible signal.

| #   | Scenario                               | Expected behavior                                                                                                                                                                                                                                                                                                                    | Operator signal                                                                                                                                                                    |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Old worker + new settings revision** | Old worker whose code < revision `min_reader_version` **holds last-applied revision**, does not mis-apply                                                                                                                                                                                                                            | Skew-age alert + `/metrics` skew gauge; resolves as old workers cycle out                                                                                                          |
| 2   | **New worker + old revision**          | New worker reads the current (older) revision normally; `min_reader_version` only blocks the reverse direction                                                                                                                                                                                                                       | No alert; normal convergence                                                                                                                                                       |
| 3   | **Mixed-version workers mid-deploy**   | Both serve; lease fencing + image digest keep terminal writes correct; no split-brain on a run                                                                                                                                                                                                                                       | Worker inventory shows mixed image digests; normal during deploy                                                                                                                   |
| 4   | **Migration vs old worker**            | Additive-only migrations; one pg advisory lock (inside `migrate()`) serializes every explicit migrator. Workers with `GANTRY_SKIP_MIGRATIONS=1` skip migration and fail readiness if the schema is missing; old worker runs against newer additive schema                                                                            | Migration runs once (lock holder); losers wait; failure exits non-zero or readiness stays red if schema was not seeded                                                             |
| 5   | **Bake artifact vs old worker**        | New artifact is replace-on-update; a worker still holding the prior artifact keeps serving until it reconciles (fetch → sha256 verify → atomic activate)                                                                                                                                                                             | Capability advertised only after activate; hash mismatch → quarantine + `gantry artifacts quarantine rebake`                                                                       |
| 6   | **Live worker drains during deploy**   | The draining worker stops admitting and finishes/hands off its owned turns; other live workers keep admitting throughout. If the worker held the recovery-coordinator lease it releases it early and any live worker is re-elected; turns the previous coordinator never recovered resume on the new one at a higher fencing version | Live-turn `recovered` state for any turn that lost its owner; no global live-chat pause (only the draining worker's owned turns move). Coordinator failover RTO ≈ lease TTL (~30s) |

## Security Posture vs Topology

These are **two axes** ([Deployment Modes](../decisions/2026-06-11-deployment-modes.md)):

- **Topology** = `runtime.deployment_mode` (`workstation|fleet`), a settings key.
- **Security posture** = the existing env var (values `production|remote`),
  renamed to `GANTRY_SECURITY_POSTURE` in Phase 3.

Composition: **fleet requires production posture**; workstation defaults to
relaxed local posture and may opt into production. Fleet `/readyz` fails if the
posture is not production.

## Browser Note

With multi-live execution, browser-bearing turns can land on **different live
workers** — successive turns for the same agent may admit on different boxes, and
a recovered turn resumes wherever the recovery coordinator runs. Browser profiles
(cookies, sessions, logged-in state) **now follow the conversation across live
workers** via a durable cross-worker snapshot store.

**Lifecycle.** When a turn that actually used the browser finishes (live turn
finalize, or scheduled job browser cleanup), the worker closes Chrome so the
bytes are quiescent and **snapshots** the profile's `user-data/` tree (cookies,
logins, `Local State`, storage leveldbs — caches and host-local junk excluded)
to the artifact store, then records the content hash + storage ref on the
`browser_profiles` row. Before Chrome launches for that profile on any worker,
the launch path **restores** the snapshot: if the recorded content hash differs
from the local copy (or there is none), it materializes the bytes atomically
(temp dir → sha256-verify → swap), exactly like the toolchain artifact cache,
quarantining on integrity mismatch. The same-worker fast path is a no-op (a local
marker already matches), so the workstation single-process deployment carries
effectively zero overhead. A stale recovered-from worker cannot clobber a newer
snapshot: the upsert is monotonic last-writer-wins keyed on the lease fencing
version, so a higher-fence owner always wins.

**Storage / IAM.** Snapshots live under the `browser-profiles/` prefix of the
capability artifact store (local FS or S3, following `runtime.artifactStore`).
Unlike toolchain artifacts (bake-rw / worker-ro), browser profiles are written by
workers at turn end, so the **worker role needs read-write on the
`browser-profiles/` prefix** (encoded as the `worker_browser_rw` policy in the
Terraform storage module). There is no profile GC/TTL yet — snapshot rows and
objects grow unbounded (see [TODOS.md](../../TODOS.md)).

**Treat snapshot objects as credential-grade secrets.** The full-minus-cache
bundle includes Chrome's `Login Data` (the saved-passwords SQLite DB) and the
`Local State` `os_crypt` key material; on headless Linux that key is typically
derivable, so a snapshot object is effectively a plaintext credential store, not
just opaque session state. There is no application-layer encryption — protection
rests entirely on the bucket posture: SSE-KMS at rest, prefix-scoped worker-rw
IAM (no cross-tenant read), and S3 public-access block.

The per-agent browser **kill-switch** still applies: it disables `Browser` for any
agent that must not depend on a (now durable) browser profile at all.

## Worker Configuration (sandboxed agent child processes)

Each worker is one parent Node process that spawns a child runner process per
active agent turn. Sessions are Postgres rows and cost nothing while idle; the
configuration below bounds what an _active_ sandboxed child may consume and what
the host must provide for the sandbox to exist at all.

Recommended fleet worker desired state (settings; the process role itself is the
deployment env `GANTRY_PROCESS_ROLE`, **not** a settings key):

```yaml
runtime:
  deployment_mode: fleet
  queue:
    max_message_runs: 6 # PER live worker: concurrent live turns on one box.
    # Cluster live capacity ≈ this × live-worker count.
    max_job_runs: 4 # concurrent scheduled-job runners (per job worker)
    drain_deadline_ms: 120000
  sandbox:
    provider: sandbox_runtime # whole-runner OS sandbox (bubblewrap on Linux)
    resource_limits:
      cpu_seconds: 900 # hard CPU budget per child runner
      memory_mb: 512 # hard memory cap per child runner
      max_processes: 64 # runner + SDK subagents + tool subprocesses
  artifact_store:
    driver: s3
```

Sizing rule: instance memory ≥ 1 GB (parent + OS headroom) +
(`max_message_runs` + `max_job_runs`) × `resource_limits.memory_mb`. The example
above fits a 7–8 GB instance. Subagents run inside their parent turn's runner and
share its caps — `max_processes` is the fan-out bound (see the subagent slot
weighting item in [TODOS.md](../../TODOS.md)).

Host execution slots use `GANTRY_HOST_ID` when present, falling back to the OS
hostname. If multiple runtime processes share one machine, set the same
`GANTRY_HOST_ID` for all of them so status and slot accounting describe one host.
The local fleet compose file does this for the co-located rehearsal stack.

Host/container requirements for `sandbox_runtime` on fleet workers:

- `bubblewrap` is in the worker image (`ops/docker/Dockerfile`).
- Namespace creation inside Docker requires a user-namespace-capable seccomp
  profile on `docker run`; the default profile may block it. Raw Docker and
  compose rehearsal use `seccomp=unconfined`. ECS task definitions do not accept
  that Docker security option, so ECS/EC2 fleet workers must run the Gantry
  container with `privileged: true` before boot. Fleet production and fleet
  rehearsal must set `provider: sandbox_runtime`, because the production
  security gate rejects `direct`.
- Container `--pids-limit` should exceed
  (`max_message_runs` + `max_job_runs`) × `max_processes`.
- Disk: ≥ 20 GB for image, per-run temp workspaces, artifact cache, and bake
  temp dirs.

Operator sizing guidance (instance classes, scaling levers, autoscaling) lives in
the [AWS Terraform runbook](../deployment/aws-terraform.md) "Sizing and scaling"
section.

## Scaling Decision Guide (vertical vs horizontal)

Gantry scales on two axes and they solve different problems. **Vertical** =
bigger instances and higher per-worker concurrency (`runtime.queue`,
`runtime.sandbox.resource_limits`). **Horizontal** = more workers in the
autoscaled pool. Start from the symptom, not the axis:

| What is actually growing / hurting                                                                            | Scale                                                                                                                       | Levers                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live conversations: turns wait behind per-worker `max_message_runs`, users see "Still starting this request." | **Horizontal (live pool)** — every live worker admits turns; cluster live capacity ≈ `max_message_runs` × live-worker count | Raise `live_worker_max_size` / `live_worker_desired_capacity`, or bigger `live_worker_instance_type` + higher `runtime.queue.max_message_runs` per box. Both add capacity now |
| Scheduled jobs, bakes: queue depth grows, job-worker CPU sustained high                                       | **Horizontal (job pool)** — jobs are claimable by any job worker                                                            | Raise `job_worker_max_size`, tune `job_worker_cpu_target`                                                                                                                     |
| Admin/API latency (control plane): `/v1/*` slow, SDK calls back up                                            | **Vertical (control), then horizontal** — control runs no execution, so this is rare                                        | Bigger `control_instance_type`; raise `control_max_size` + set `control_autoscaling_enabled` if genuinely API-bound                                                           |
| Single turns are too heavy: worker memory pressure, OOM-killed runners, subagent-dense turns                  | **Vertical** — more workers do not shrink one turn's footprint                                                              | Bigger instance, or cap harder via `resource_limits` (memory_mb / max_processes); see the sizing rule in Worker Configuration above                                           |
| Availability: live failover tolerance, deploy safety                                                          | **Horizontal floor** — independent of throughput                                                                            | `live_worker_min_size >= 2` (enforced); recovery-coordinator failover RTO ≈ lease TTL (~30s); other live workers keep serving during a single worker's drain                  |
| Everything is slow but workers are idle                                                                       | **Neither** — look at the database                                                                                          | RDS instance class, RDS Proxy pool, `pgboss` queue health                                                                                                                     |
| Cost at idle                                                                                                  | **Neither** — scale down to the floor, never to zero                                                                        | Fleet floor: ≥2 live workers + 1 control + 1 job worker; support stack floor 1; per-turn runner compute is already zero at idle                                               |

Signals to read before choosing (`/metrics` + CLI):

- Job-queue depth rising while job-worker CPU is high → horizontal job pool (the
  autoscaler should already be reacting; check `job_worker_max_size`).
- Live turns waiting (`gantry_live_oldest_waiting_seconds` or
  `gantry_live_admission_backlog` climbing, with `gantry_live_warm_spare` = 0)
  while live workers report saturated local capacity → horizontal live pool
  (more `live-worker` instances) and/or higher per-worker `max_message_runs`.
- `gantry_capability_starved_runs` > 0 → neither axis: a capability is missing
  (bake failed/pending, or no eligible worker) — `gantry bake status`.
- Worker memory headroom shrinking with stable turn counts → vertical, or
  tighter `resource_limits`.

**Workstation → fleet is the same decision one level up.** Stay on a
workstation (`all` role, vertical only) while one machine's failure is acceptable
and total load fits one box — it keeps live installs and the simplest ops. Move
to fleet when you need availability (no single point of failure for live chat),
chat or job throughput beyond one machine, separation of the admin control plane
from public execution workers, or locked public-facing agents on isolated stacks.
Unlike the original single-live-host fleet, **live-chat capacity is now a valid
reason to move to fleet** — the live pool scales horizontally.

## Health, Readiness, and Metrics by role

Operational endpoints stay internal-only (`/healthz`, `/readyz`, `/metrics`); the
ALB never exposes them. They are role-aware:

- **`/readyz`** carries a top-level **`role`** field plus role-specific checks on
  top of the shared `database`/`migrations`/`settings`/`draining` checks:
  - `control` adds **`api_auth`** (control API keys configured).
  - `live-worker` adds **`worker_registered`** (a `worker_instances` row exists)
    and **`live_capacity`** (`'available'` or `'saturated'`). Saturation is
    **reported, never failed** — a saturated live worker stays ready and shows
    backpressure; readiness does not flap on a busy box.
  - `job-worker` adds **`worker_registered`** and **`scheduler`** (the scheduler
    loop is claiming).
  - `all` is unchanged (the shared checks only).
- **`/metrics`** adds:
  - `gantry_process_role{role}` — the process's role.
  - `gantry_live_turns_active` — live turns this process currently owns.
  - `gantry_live_slots_used_cluster` — cluster-wide live-worker slots in use.
  - `gantry_live_slots_used_local` — interactive host slots in use on this
    runtime host.
  - `gantry_live_slots_capacity_local` — host-clamped live capacity on this
    runtime host.
  - `gantry_live_warm_spare` — 1 when this runtime host has a free live slot.
  - `gantry_live_turns_recoverable` — live turns awaiting recovery.
  - `gantry_live_oldest_waiting_seconds` — age of the oldest waiting live turn
    (the horizontal-live-pool scale signal).
  - `gantry_live_admission_backlog` and
    `gantry_live_admission_backlog_oldest_seconds` — queued live-admission work.
  - `gantry_background_job_slots_used` and
    `gantry_background_job_slots_capacity` — background job slot usage.
- **`/v1/health`** (authenticated, `sessions:read`) carries **`processRole`**.
- `gantry status` shows the process role.

**Overload UX.** Inbound is accepted durably; nothing is dropped. When a turn
waits past a threshold, the user sees the literal status **"Still starting this
request."** (sent once per waiting episode by the recovery coordinator). Worker
capacity language stays operator-only. Recovery keeps the existing message: **"Run
recovered: previous worker lost its lease; Gantry safely retried this run."**

## Runbook Index

| Runbook                                                                                                                      | Location                                              | Status             |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------ |
| AWS Terraform deployment (prerequisites → secrets → terraform → seeding → first locked agent → health → rollback → teardown) | `docs/deployment/aws-terraform.md`                    | Created in Phase 2 |
| Locked support stack                                                                                                         | `envs/support` (covered in the AWS Terraform runbook) | Created in Phase 2 |

Measured gates (from the implementation plan): local compose → first agent turn
≤ 15 min; clean AWS account → first locked support-agent turn ≤ 60 min, both via
copy-paste runbook.

## See Also

- [personal-and-enterprise-modes.md](./personal-and-enterprise-modes.md) —
  workstation ↔ personal, fleet ↔ enterprise mapping.
- [multi-worker-execution.md](./multi-worker-execution.md) — job-worker leases,
  fencing, recovery.
- [live-horizontal-execution.md](./live-horizontal-execution.md) — durable
  multi-worker live turns; the recovery-coordinator lease.
- [Process Roles and Multi-Live ADR](../decisions/2026-06-12-process-roles-and-multi-live.md)
  — the role model, control-plane separation, and the multi-live cutover.
- [TODOS.md](../../TODOS.md) — deferred items (browser snapshots, GCP/Azure, etc.).
