# Scaling and Deployment

Gantry ships one Node.js binary. A workstation runs all responsibilities in one
`all` process; a fleet can start the same image with separate `control`,
`live-worker`, and `job-worker` roles. The interactive
[fleet view](./atlas/fleet-execution.architecture.html) shows this topology;
[Deployment Profiles](./deployment-profiles.md) owns the exact settings,
readiness, sandbox, and upgrade matrices.

## Two independent deployment axes

Do not combine topology with security posture:

- `runtime.deployment_mode: workstation | fleet` is desired state stored in
  Postgres settings revisions;
- `GANTRY_SECURITY_POSTURE` is deployment-owned security posture;
- `GANTRY_PROCESS_ROLE` is the boot-time process lane.

Fleet requires production security posture. `direct` versus
`sandbox_runtime` is a separate execution-confinement choice; fleet does not
silently force either provider.

## Process roles

| Role | Full control API | Live execution | Job execution | Provider inbound | Settings writes | Worker row |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `all` (default) | yes | yes | yes | yes | yes | yes |
| `control` | yes | no | no | no | yes | no |
| `live-worker` | ops/read-only only | yes | no | yes | no | yes |
| `job-worker` | ops/read-only only | no | yes | no | no | yes |

`GANTRY_PROCESS_ROLE` is resolved once at boot and unknown values fail loudly.
The `control` role owns administrative mutation but executes no model or job
work. Worker roles expose health, readiness, metrics, status, and diagnostics;
admin mutation routes are not mounted.

Workstation compatibility comes from `all`, not from a second runtime. Native
provider subagents remain inside their parent runner process; role separation
does not turn them into remote workers.

## Coordination through Postgres

Fleet processes do not coordinate through shared memory or a central in-process
queue. Postgres owns:

- versioned desired settings and worker convergence;
- canonical conversations, messages, sessions, runs, jobs, and events;
- durable live-admission rows and one-active-turn scope uniqueness;
- worker registration and heartbeats;
- run leases, slot holds, monotonic fencing versions, and terminal settlement;
- live-turn command inboxes and pending interactions;
- scheduler definitions, triggers, setup state, and job evidence;
- memory, company brain, permissions, and artifact metadata.

`pg_notify`/`LISTEN` reduces wakeup latency but is never the work record.
Poll/backstop loops claim durable rows after lost or coalesced notifications.
Settings projection is serialized per app with an advisory lease and re-reads
the head revision while holding that lease.

## Settings authority

Both deployment modes use the same desired-state service and validation:

- on a workstation, the `settings.yaml` watcher imports a valid edit into
  `settings_revisions` first, then synchronizes the readable YAML copy and
  runtime projection;
- in a fleet, the control API is the mutation surface. YAML is explicit
  bootstrap, import, export, and backup only; workers do not watch it;
- workers receive revision wakeups plus a poll fallback;
- a worker older than `min_reader_version` holds its last-applied revision,
  alerts, and stays not-ready rather than misapplying new state;
- revision projection failures retry the latest full state and keep readiness
  red until convergence.

Process role remains outside settings because it decides which subsystems boot.

## Live-worker capacity

Every live worker runs durable admission and may own turns. The singleton lease
is only for the recovery coordinator; it is not a hot-path live-host lease.

For each live worker:

```text
potential concurrent live turns = runtime.queue.max_message_runs
```

The slot key includes the worker instance, so N healthy live workers provide up
to N times that configured turn capacity. This is potential capacity, not a
throughput promise: actual throughput is bounded by model latency and quotas,
provider receive/send limits, database contention, artifact I/O, CPU, and
memory.

One heavy turn is not made smaller by adding workers. Size each host for the
parent/OS plus every possible child runner:

```text
instance memory >= 1 GiB parent/OS headroom
                  + (max_message_runs + max_job_runs)
                    * resource_limits.memory_mb
```

Use vertical scaling or stricter runner limits for OOM pressure within a turn;
use more live workers for independent queued turns after the current
cluster-authority constraints below are resolved.

## Job-worker capacity

Job workers claim due runs through the scheduler's transaction and receive a
lease token/fence before execution. Cluster-wide job slots cap the configured
scope, and expired holds can be reclaimed. More job workers increase capacity
only when there is unclaimed parallel work and the database/model/provider
ceilings can support it.

Jobs do not use live-turn command routing. They keep their own sessions,
durable interactions, tool evidence, notification routes, and fenced terminal
settlement.

## Provider single-consumer constraints

Horizontal live execution does not mean every worker can consume every native
connection simultaneously.

| Transport shape | Ownership rule |
| --- | --- |
| Telegram `getUpdates` and other polling connections | One worker holds a per-bot advisory lease such as `telegram:poll:<botTokenHash>`. On loss, another worker can acquire it. |
| Slack Socket Mode and Teams SDK push connections | The adapter does not use the polling lease. Deployment/provider connection semantics still determine how many simultaneous connections are valid. |
| Webhook or load-balanced HTTP ingress | The load balancer may route requests across live workers; durable admission resolves execution ownership. |
| Outbound-only channel connection on control/job roles | May support delivery without accepting provider inbound; it never acquires inbound polling/socket ownership. |

Whichever process receives a message persists it with the exact Provider
Account route. Any live worker may later claim the durable admission. Delivery
still uses that installed account; there is no credential/account fallback.

## Recovery and fencing

### Live work

- One active non-terminal row per durable scope prevents duplicate turns.
- The owner renews its run lease and capacity hold together.
- Continuations, stops, and resolved interactions are durable sequenced commands,
  so they can arrive at any worker.
- A recovery-coordinator advisory lease elects one sweep owner. Other live
  workers continue admitting and executing.
- Recovery reclaims an expired turn with a strictly higher fence. Late writes
  and command acknowledgements from the stale worker fail.
- A draining coordinator releases its coordinator lease early; a standby takes
  the sweep. Active turns remain governed by their own leases.

### Job work

- Worker heartbeats make stale instances visible.
- Job claims and run creation are atomic.
- Retry claims receive a higher fencing version.
- Only the current lease token can settle the run or stamp notification
  evidence.

### Settings and browser state

- Settings revisions converge by notification plus polling and a per-app
  projector lease.
- Browser profiles use a durable advisory lease and generation so a stale
  process cannot overwrite the current profile snapshot.

## Artifacts and filesystem state

Postgres stores artifact metadata, not every byte. Workstation mode may use a
local filesystem artifact root. Any fleet workers that can claim the same run
must see the same FileArtifact and skill bytes, normally through a shared/object
artifact implementation. A container-local directory is not a fleet store.

Provider runner directories, Claude settings, and provider JSONL are temporary
materializations. They are not shared continuity state and must not be promoted
into a synchronization mechanism.

## Current operational ceilings

The role split and durable coordination mechanisms are shipped, but the current
accepted decisions also pin two process-local authorities:

1. **Rate limits are single-instance-authoritative.** In-memory LLM, provider
   send, and per-app counters multiply if several runtime instances share one
   database. Before shipping a multi-instance/blue-green/fleet deployment, move
   those counters to a cluster-authoritative store and supersede decision 0099.
2. **LLM concurrency admission is process-local.** Its global/per-app ceilings
   bound one process's sockets and memory, not the cluster aggregate. Shared
   admission remains deferred.

Therefore the current safe production contract is a single runtime instance
for rate-limit purposes. The multi-role topology is an implemented scaling
mechanism and rehearsal target, but it is not authorization to run an
unbounded multi-instance production fleet against one database before the
cluster-authority trigger is completed.

Other ceilings remain even after that work:

- provider API quotas and bot connection ownership;
- Postgres connection, lock, I/O, and maintenance capacity;
- model gateway/provider latency and quotas;
- artifact-store availability and bandwidth;
- child-runner memory and process limits;
- customer-owned networking, identity, secrets, retention, logging, and
  incident response.

Gantry makes claims and recovery inspectable; it does not provide an SLA,
automatic regional failover, a hosted tenant control plane, or unlimited linear
scaling.

## Workstation-to-fleet path

1. **Stay on workstation while one host meets load and availability needs.** Use
   `all`, Postgres, the watched YAML import surface, and local artifacts.
2. **Exercise production posture and explicit limits on one host.** Confirm
   readiness, provider ownership, runner memory, sandbox choice, backup, and
   restore behavior.
3. **Move shared state out of host-local paths.** Use managed/shared Postgres and
   an artifact store visible to every possible claimant.
4. **Complete cluster-authoritative rate-limit and LLM-admission work.** This is
   a prerequisite for safe multi-instance deployment under current decisions.
5. **Split the same image by role.** Route `/v1/*` administration to control,
   provider/webhook ingress to live workers, and scheduler work to job workers.
6. **Scale one bottleneck at a time.** Add live workers for independent chat
   turns, job workers for queued jobs, or larger hosts for heavy individual
   runners. Observe database, model, provider, artifact, and memory ceilings.
7. **Test loss, not only readiness.** Drain the recovery coordinator, kill a
   live owner and job owner, lose a notification, roll settings across mixed
   versions, and verify higher-fenced recovery and no duplicate delivery.

For concrete role checks, metrics, and upgrade cases, continue with
[Deployment Profiles](./deployment-profiles.md). For turn-level recovery, see
[Live Horizontal Execution](./live-horizontal-execution.md) and
[Multi-Worker Job Execution](./multi-worker-execution.md).
