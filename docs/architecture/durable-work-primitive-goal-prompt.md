# Goal: Durable-work primitive and coordination hardening

**Status: validated against the 2026-07-19 tree; awaiting user sign-off.**
Implementation runs through the Gantry goal pipeline, one stage at a time. The
core primitive is ready to build. The retention slice has a mandatory policy
gate in Stage 9; do not invent retention windows or a system actor while
implementing an earlier stage.

## Provenance

Four inputs, in order; current-tree evidence below corrects all of them:

1. `docs/architecture/fable-architecture-review-2026-07-16.md:10-21` supplied
   the original umbrella: approximately ten lease/claim/retry copies plus
   durable send and IPC-backpressure fixes.
2. `docs/architecture/goals-index.md:55-61` widened the cycle to retention,
   IPC backpressure, `send_message`, A3 review dedup, and callable-agent
   follow-up JSON state; `docs/architecture/goals-index.md:70-71` made jobs
   recovery columns/CAS and the B2 hardening batch candidates to fold in.
3. `docs/architecture/coordination-representation-audit-2026-07-18.md:87-96`
   defined A3, `:125-152` defined B1, and `:156-194` defined B2.
4. `docs/architecture/permission-durable-storage-goal-prompt.md:65-83` and the
   shipped schema at
   `apps/core/src/adapters/storage/postgres/schema/worker-coordination.ts:136-214`
   provide the closest single-winner claim and idempotent-settlement precedent.

This validation used `rg` plus direct source reads because this worktree has no
initialized `ccc` index; initializing it would itself violate this task's
one-file write boundary.

## Why

The current tree does have repeated ownership machinery, but the original
"four parallel lease schemas" diagnosis is stale. `run_leases` is already the
authoritative, monotonic execution lease
(`apps/core/src/adapters/storage/postgres/schema/worker-coordination.ts:54-106`),
and scheduled jobs atomically create that lease before projecting the run onto
`agent_runs` and `jobs`
(`apps/core/src/adapters/storage/postgres/repositories/canonical-job-claim.postgres.ts:17-120`).
Live turns use the same authority
(`apps/core/src/application/live-turns/live-turn-lease-service.ts:174-273`) and
fence terminal writes through it (`:422-519`). The `jobs.lease_*` and
`agent_runs.lease_*` columns are projections, not two more authorities
(`apps/core/src/adapters/storage/postgres/schema/jobs.ts:20-62`,
`apps/core/src/adapters/storage/postgres/schema/runs.ts:24-100`).

The safe consolidation target is therefore narrower: one application-layer
`DurableWorkClaimService` over a `durable_work_claims` history table, for work
that needs claim, renew, release, expire/reclaim, monotonic fencing, and
idempotent terminal settlement. It owns **only ownership**. Work identity,
payload, due/defer time, attempts, retry policy, partial-delivery meaning, and
business outcome stay in the owning table. A consumer's state write must test
the active `(workKind, workId, claimToken, ownerId, fencingVersion)` in the same
SQL transaction (or single guarded statement); a later generic settle may be
replayed after a crash. Never copy a consumer's state machine into generic
JSON. This boundary avoids the known consolidation-fidelity failure: an
expired outbound provider dispatch is ambiguous, while an expired live
admission claim is safely retryable
(`apps/core/src/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.claims.ts:43-124`,
`apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts:166-214`).

### Current-tree inventory and fold verdict

| Live implementation                                   | Fact, lifecycle, and failure semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Verdict                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run execution leases and slots                        | `run_leases` stores the active worker, token, monotonic fence, heartbeat and expiry; claim expires lapsed leases and increments the fence, and settlement rejects a stale/expired owner (`apps/core/src/adapters/storage/postgres/repositories/worker-coordination-lease.postgres.ts:62-141`, `:148-228`). `run_slots` is a renewable capacity semaphore, not a work claim (`apps/core/src/adapters/storage/postgres/schema/worker-coordination.ts:109-134`). Scheduler recovery clears projections only when no live `run_leases` row exists (`apps/core/src/adapters/storage/postgres/repositories/canonical-job-lease-release.postgres.ts:7-94`).                                                                                 | **Do not fold.** This is security/execution authority and the model for the new API. Keep `jobs`/`agent_runs` projections until a separate projection-removal proof shows no scheduling or status reader needs them.                                                                   |
| Permission prompt claims                              | `permission_prompts` stores one human decision reservation and settlement state; one guarded update checks every member pending/unexpired, release restores open, and repeated identical settlement succeeds (`apps/core/src/adapters/storage/postgres/repositories/worker-coordination-permission-prompt.postgres.ts:322-430`). It has no heartbeat or worker takeover.                                                                                                                                                                                                                                                                                                                                                             | **Do not fold.** Human approval reservation is not worker execution. Extend this table only for A3's durable review key in Stage 6.                                                                                                                                                    |
| Live admission work                                   | `live_admission_work_items` stores message identity, FIFO/defer state, retries/failures and embedded claim fields (`apps/core/src/adapters/storage/postgres/schema/live-turns.ts:134-209`). Claim merges queued, due-deferred and expired work, increments fence/retry, renews, defers, and settles with token/owner guards (`apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts:120-318`).                                                                                                                                                                                                                                                                                        | **Fold claim API/table; keep the work table.** Delete its claim owner/token/expiry/fence columns, but keep idempotency, FIFO, defer, retry and failure state.                                                                                                                          |
| Async agent tasks                                     | `agent_async_tasks` stores task state plus embedded token/fence/heartbeat (`apps/core/src/adapters/storage/postgres/schema/async-tasks.ts:15-65`). Backlog/scoped admission is advisory-lock guarded; claim increments the fence; transitions are token/fence CAS (`apps/core/src/adapters/storage/postgres/repositories/async-task-repository.postgres.ts:41-193`, `:250-306`).                                                                                                                                                                                                                                                                                                                                                     | **Fold claim API/table; keep the task table.** Admission limits remain task-domain rules. Delete embedded lease fields after all task transitions use the durable-work fence.                                                                                                          |
| Callable-agent follow-up                              | Pending intent remains a `privateCorrelationJson.callableAgentFollowUp` key and delivered state remains a `receiptJson` key (`apps/core/src/jobs/async-delegated-agent-follow-up.ts:11-74`, `:76-136`). Recovery scans only the newest 100 terminal delegated tasks (`apps/core/src/jobs/async-command-task-service.ts:764-789`), and receipt marking is an unfenced whole-document write (`apps/core/src/adapters/storage/postgres/repositories/async-task-repository.postgres.ts:237-247`). The inserted message ID is deterministic (`apps/core/src/jobs/async-delegated-agent-follow-up.ts:95-124`), which limits duplicate visible turns but does not make discovery complete.                                                  | **Fold as a real work item.** Add an `async_task_follow_ups` row keyed by task ID, claim it through the primitive, and delete both JSON flags and the newest-100 scan.                                                                                                                 |
| Durable outbound delivery                             | Delivery items own ordering, attempt count, retry time, partial visibility, and embedded claim fields (`apps/core/src/adapters/storage/postgres/schema/outbound-delivery.ts:102-166`). Claim is FIFO by unsent ordinal and increments attempts (`apps/core/src/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.claims.ts:126-261`); an expired claim becomes `partially_delivered`, never a blind retry (`:43-124`). Terminal writes are token-fenced and retry state is domain-specific (`apps/core/src/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.ts:300-368`).                                                                                                     | **Fold claim API/table last; keep delivery tables and all ambiguity/retry semantics.** An expiry callback must atomically apply the outbound-specific ambiguous outcome.                                                                                                               |
| Control webhook deliveries                            | `status='delivering'` plus `nextAttemptAt` is an implicit 15-second lease; claim increments attempts under `SKIP LOCKED` (`apps/core/src/adapters/storage/postgres/repositories/control-plane-webhook-claim.postgres.ts:23-73`). Delivered/retry/dead writes filter only by delivery ID, so an old attempt can settle a newer one (`apps/core/src/adapters/storage/postgres/repositories/control-plane-repository.postgres.ts:537-617`).                                                                                                                                                                                                                                                                                             | **Fold first as the proof consumer; keep webhook retry fields.** Add a real fence to every terminal/retry write.                                                                                                                                                                       |
| Event-bus outbox fan-out                              | Rows are locked, converted idempotently into webhook deliveries, and settled inside one database transaction (`apps/core/src/adapters/storage/postgres/repositories/event-bus-outbox.postgres.ts:112-224`). No external work occurs while ownership is retained.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **Do not fold.** A lease would weaken an already atomic transactional-outbox transfer. Remove dead-looking retry fields only if a separate zero-reader proof supports it.                                                                                                              |
| Toolchain bake                                        | `runtime_dependencies.status` is the lease: queued→baking CAS, external install/upload, then terminal CAS; a stale `updated_at` reaper resets baking→queued, and double bake is tolerated (`apps/core/src/jobs/toolchain-bake-executor.ts:65-112`, `:129-143`; `apps/core/src/jobs/toolchain-bake-reaper.ts:64-109`). The repository only guards `fromStatus` (`apps/core/src/adapters/storage/postgres/repositories/runtime-dependency-repository.postgres.ts:163-199`).                                                                                                                                                                                                                                                            | **Fold claim API/table; keep dependency status/artifact state.** Replace age-as-lease and the custom reaper with heartbeat/expiry/fencing.                                                                                                                                             |
| Memory dream runs                                     | `memory_dream_runs` combines history/status with an expiry and partial unique indexes (`apps/core/src/adapters/storage/postgres/schema/schema.ts:173-210`). Acquisition is find→expire→find→insert with a unique-conflict retry, while finalization updates by run ID only (`apps/core/src/memory/app-memory-trigger-dreaming.ts:153-232`).                                                                                                                                                                                                                                                                                                                                                                                          | **Fold claim API/table; keep dream-run history.** Terminal writes must use the generic fence; phase-conflict rules stay memory-owned.                                                                                                                                                  |
| Memory embedding backfill                             | `memory_embedding_backfill_runs` uses a partial unique `status='running'` row as inline-run ownership, while run and item rows retain counts, pause/resume time and retryable errors (`apps/core/src/adapters/storage/postgres/schema/schema.ts:353-478`). Acquisition relies on the unique violation and finalization updates by run ID without a fence (`apps/core/src/memory/app-memory-backfill.ts:208-241`, `apps/core/src/memory/app-memory-backfill-runs.ts:55-88`); item retry/backoff is explicit domain state (`apps/core/src/memory/app-memory-backfill.ts:360-421`).                                                                                                                                                     | **Fold run ownership; keep both history/item tables and retry policy.** Use the generic fence for run finalization; do not turn each embedding item into a generic claim unless tests first prove concurrent item workers exist.                                                       |
| Job retry and recovery intent                         | Scheduler retry/backoff and pause thresholds are job policy (`apps/core/src/jobs/execution-finalization.ts:116-235`, `:297-305`). Recovery intent, consecutive failures, and pause reason are still rebuilt inside `target_json` (`apps/core/src/adapters/storage/postgres/services/canonical-job-ops-service.ts:465-543`); recovery transitions do unlocked read/merge/write (`:100-110`, `apps/core/src/application/jobs/job-recovery-intent-service.ts:61-118`), and malformed shapes become absent (`apps/core/src/adapters/storage/postgres/services/canonical-job-target-state.ts:48-104`). The dedupe key is now a stable SHA-256, not raw stringify (`apps/core/src/application/jobs/job-recovery-intent-service.ts:25-58`). | **API/columns only; do not put it in the claim table.** Stage 7 promotes coordination fields and adds atomic CAS while scheduler execution continues to use `run_leases`.                                                                                                              |
| Manual job triggers                                   | `job_triggers` moves pending→claimed by row lock/CAS, binds the trigger to a run, then marks it completed/failed (`apps/core/src/adapters/storage/postgres/repositories/control-plane-job-triggers.postgres.ts:14-112`). It has no independent lease because the bound run is protected by `run_leases`.                                                                                                                                                                                                                                                                                                                                                                                                                             | **Do not fold.** This is durable trigger-to-run correlation; its execution ownership is already the run lease. Any stale claimed-trigger bug should be repaired from the bound run outcome, not by a second claim.                                                                     |
| A3 review dedup                                       | Three process-local Sets still guard request-only, skill-command, and skill-package prompts (`apps/core/src/jobs/ipc-admin-handlers.ts:89`, `:321-324`, `:643-645`; `apps/core/src/jobs/ipc-skill-install-handlers.ts:38-39`, `:150-165`, `:377-395`, `:463-468`). Request-only identity is order-sensitive `JSON.stringify` (`apps/core/src/jobs/request-only-capability-dedupe.ts:1-22`). `pending_access_requests` has no durable content key or uniqueness (`apps/core/src/adapters/storage/postgres/schema/pending-access-requests.ts:4-36`), and its best-effort insert uses a random ID before prompting (`apps/core/src/jobs/ipc-admin-handlers.ts:534-586`).                                                                | **Existing-table API only.** Add canonical content hash and an open-row unique index to the durable approval envelope, reserve before rendering, and delete all three Sets. Human waits do not consume worker leases.                                                                  |
| Session compaction and async admission fallbacks      | The compaction Set is consulted only when `admitSessionCompactionTask` is absent (`apps/core/src/session/session-compaction-command.ts:53-79`) and cleared after work (`:217`). Async admission still falls back to lock-free count-then-insert when the durable port is missing (`apps/core/src/jobs/async-task-admission.ts:17-50`), despite the Postgres advisory-locked implementation (`apps/core/src/adapters/storage/postgres/repositories/async-task-repository.postgres.ts:41-77`).                                                                                                                                                                                                                                         | **Delete with the async-task migration.** Make durable admission required; add no shim or second queue.                                                                                                                                                                                |
| Filesystem interaction IPC                            | The watcher atomically renames request files, but a single global 100-entry Set governs permission/question concurrency (`apps/core/src/runtime/ipc.ts:46-52`, `:512-588`, `:657-736`). Capacity and duplicate-in-flight exceptions enter the generic failure path and archive valid requests (`apps/core/src/runtime/ipc.ts:589-620`, `:737-768`). Ordinary message requests already await durable channel delivery before deleting their claimed file (`apps/core/src/runtime/ipc.ts:275-320`).                                                                                                                                                                                                                                    | **Fold processing ownership, not filesystem ingestion, in Stage 8.** Persist accepted request metadata/cursor, claim through the primitive, use per-lane/per-agent capacity, and defer rather than archive. Keep filesystem rename as the trusted ingress handoff until DB acceptance. |
| Skill/file resource serialization and browser fencing | Skill materialization uses an explicitly process-local promise mutex (`apps/core/src/shared/skill-install-lock.ts:1-28`). File artifact version allocation uses a transaction advisory lock (`apps/core/src/adapters/storage/postgres/repositories/file-artifact-repository.postgres.ts:62-129`, `:332-350`). Browser snapshot writes use a monotonic last-writer fence (`apps/core/src/adapters/storage/postgres/repositories/browser-profile-snapshot-repository.postgres.ts:49-117`).                                                                                                                                                                                                                                             | **Do not fold.** These serialize mutable resource versions, not execution of a durable work item. Skill materialization needs versioned CAS in its own table; browser fencing and file locks already preserve different invariants.                                                    |
| Process-local scheduling/presentation caches          | GroupQueue retries a live message turn in memory and drops after the configured cap (`apps/core/src/runtime/group-queue.ts:506-610`). Memory maintenance dedups and bounds ephemeral callbacks (`apps/core/src/memory/maintenance-queue.ts:120-203`). Scheduler sync coalescing is repaired by periodic full sync (`apps/core/src/infrastructure/pgboss/scheduler-engine.ts:203-272`). Capacity-delay and active-compaction Sets suppress duplicate receipts (`apps/core/src/infrastructure/pgboss/scheduler-delay-notification.ts:16-62`, `apps/core/src/app/bootstrap/runtime-services-active-compact.ts:113-139`); browser activity is a consumed per-turn hint (`apps/core/src/runtime/browser-profile-sync.ts:67-83`).          | **Do not fold in this cycle.** These are local scheduling/presentation hints, not durable authority. Any future demand for exactly-once receipts needs an outbox/idempotency-key design, not a work lease.                                                                             |

### Stale-source corrections

- The Fable claim that async-task fencing is hardcoded to `1` is stale: queued
  claims increment the stored fence
  (`apps/core/src/adapters/storage/postgres/repositories/async-task-repository.postgres.ts:140-193`).
- The Fable "fire-and-forget `send_message`" claim is stale. Channel runtime
  selects `durability: 'required'`
  (`apps/core/src/app/index.ts:112-120`), initializes a delivery before provider
  dispatch and fails closed if it cannot
  (`apps/core/src/app/bootstrap/channel-wiring.ts:382-407`), and immediate sends
  receive a deterministic idempotency key and initial claim
  (`apps/core/src/app/bootstrap/runtime-services.ts:749-788`). Stage 5 changes
  only that queue's ownership implementation; it must not add another send path.
- The pre-#233 permission JSON claim/envelope machinery and review-each replay
  are gone; relational prompt claim columns are live
  (`apps/core/src/adapters/storage/postgres/schema/worker-coordination.ts:136-214`).
  A3's three review-dedup Sets remain, as inventoried above.
- The B1 audit's storage/CAS problem remains, but its assertion that dedup is a
  plain string built from unstable input is stale: `stableSha256Json` now builds
  the key (`apps/core/src/application/jobs/job-recovery-intent-service.ts:25-58`).
- The B2 compaction Set and lock-free async-admission path remain only as
  optional fallbacks, not the normal Postgres path
  (`apps/core/src/session/session-compaction-command.ts:57-79`,
  `apps/core/src/jobs/async-task-admission.ts:17-50`). Delete them; do not
  generalize them.
- Retention remains absent from Gantry-owned runtime/job/memory ledgers. The only
  visible 14-day retention settings belong to pg-boss adapter queues
  (`apps/core/src/infrastructure/pgboss/scheduler-engine.ts:662-668`), not the
  product data named by the review. The existing ledger already records the
  unresolved actor/fencing constraints
  (`docs/architecture/arch-quick-wins-assumptions.md:8-10`).
- IPC overload remains as described, but it is specifically the permission and
  question interaction lanes; normal message IPC already waits for the durable
  send path before deleting the request file
  (`apps/core/src/runtime/ipc.ts:275-320`, `:512-620`, `:657-768`).

## Stages (each leaves the tree green; Codex per stage; autoreview per stage)

### Stage 1 — Primitive contract + webhook proof consumer

- Add the `durable_work_claims` history table and narrow domain port/application
  service. Identity is `(work_kind, work_id)`; an active row has token, owner,
  monotonic fencing version, claimed/heartbeat/expiry timestamps and status.
  A partial unique index permits one active claim. Terminal status records only
  generic `completed|failed|cancelled|released`, never consumer payload/retry
  JSON.
- Implement claim, renew, release, expire/reclaim and idempotent settle. Claim
  uses row locking plus uniqueness; a new generation is strictly greater than
  every prior generation. Same-fence/same-outcome settle succeeds on replay;
  different outcome or stale fence refuses.
- Convert webhook delivery first. Keep `attemptCount`, `nextAttemptAt`,
  delivered/dead/retry state on the webhook row, but predicate every outcome on
  the active durable-work fence. Delete `status='delivering'` as an implicit
  lease and the unfenced mark methods after zero-reference proof.
- Verification: primitive repository integration tests on a throwaway Postgres
  schema; concurrent webhook workers; forced expiry followed by a stale terminal
  write; invariants 1-8 below; `tsc`, focused unit/integration, architecture gate.

### Stage 2 — Async tasks + fallback deletion

- Route all async task kinds through the new claim service. Keep task status,
  authority, correlation, receipts, admission class and task-specific limits in
  `agent_async_tasks`; remove its token/fence/heartbeat columns after every
  transition supplies a `DurableWorkFence`.
- Make backlog/scoped admission methods required. Delete
  `createTaskWithLocalAdmission`, `queuedCompactions`, and optional durable
  compaction admission. Preserve advisory-locked capacity checks; a work claim
  does not replace a capacity semaphore.
- Verification: concurrent app/agent capacity tests, recovery at a higher fence,
  stale heartbeat/terminal/steering writes refused, session-compaction double
  admission, zero hits for deleted fallback symbols; invariants 1-9 and 11.

### Stage 3 — Callable-agent follow-up as explicit work

- Create one `async_task_follow_ups` row, unique by terminal task ID, when an
  AgentDelegation call changes from synchronous wait to async fallback. It
  references the task and carries delivery status/attempt metadata, not copied
  task output.
- Claim through the primitive; load the terminal task, insert the deterministic
  `callable-agent-follow-up:<taskId>` live-admission message, then fence and
  settle the follow-up. Recovery queries due follow-up rows directly.
- Delete `FOLLOW_UP_KEY`, both JSON readers/writers, unfenced receipt marking for
  this purpose, and the newest-100 terminal-task scan.
- Verification: crash before enqueue, crash after message insert but before
  settle, two workers, tasks older than 100 newer terminal tasks, synchronous
  completion with no follow-up; invariants 1-8 and 12.

### Stage 4 — Live admission, toolchain bake, memory work

- Migrate live admission claim/renew/defer/settle to the primitive while keeping
  FIFO, idempotency, retry/failure counts and defer reasons on its work row.
- Migrate toolchain bake ownership; replace `updated_at` staleness and the custom
  status-as-lease reaper with heartbeat/expiry. Preserve artifact hash checking,
  queue notification and domain status CAS.
- Migrate dream ownership; keep phase-conflict uniqueness and run history, and
  fence finalization. An expired dream claim becomes failed/reclaimable according
  to the memory-owned policy, not a generic default.
- Migrate embedding-backfill run ownership and fence run finalization. Preserve
  item-level retryable/blocked/ready state, backoff, provider-batch IDs and run
  counts; do not manufacture per-item leases without a concurrent worker.
- Delete each old claim/lease column, index, reaper, repository method and test in
  the same migration stage once zero-hit searches prove all consumers moved.
- Verification: per-consumer concurrency/crash tests; deferred admission remains
  FIFO; slow bake heartbeat prevents reaping; stale baker/dreamer cannot settle;
  invariants 1-10 and 13-14.

### Stage 5 — Outbound ownership migration (last/highest risk)

- Move only item ownership to the primitive. Keep item ordinal, attempt count,
  retry time, receipt/idempotency, partial delivery and delivery aggregation in
  the outbound tables.
- Claim selection and generic claim creation occur transactionally. Expiry must
  atomically mark an attempted provider dispatch ambiguous/
  `partially_delivered`; it must never apply the live-admission retry default.
  All sent/failed/partial writes test the current fence.
- Preserve required-send startup ordering and the existing `live-send:<message>`
  idempotency contract. Delete embedded claim columns and methods only after
  recovery and immediate-send callers use the service.
- Verification: crash before provider send, after provider success, during
  multipart send, and after domain settlement before generic settlement; FIFO
  tail retry; stale owner; same-outcome replay; `send_message` fail-closed tests;
  invariants 1-10 and 15-16.

### Stage 6 — A3 durable content-hash review dedup (existing prompt table)

- Define one canonical review identity from app, agent, conversation, thread,
  tool/review kind and canonicalized tool/package content. Hash with the existing
  stable SHA-256 helper. Document exactly which fields distinguish a new review.
- Add the hash to the durable permission prompt envelope (or a narrowly named
  review row if a prompt cannot yet be created), with one unique open/claimed
  row per scope/hash. Reserve durably before rendering; persistence failure
  withholds the prompt. Resolution/expiry releases the active uniqueness while
  preserving history.
- Delete all three process-local Sets and replace the order-sensitive
  request-only stringify key. Do not merge permission settlement into the work
  service.
- Verification: reordered nested input hashes equally; materially different
  scope/input differs; restart and two-process races render one prompt; expired
  and settled reviews can be requested again; invariant 17.

### Stage 7 — Jobs recovery intent columns + CAS (B1)

- Promote recovery state/kind/dedupe key/attempts/timestamps/error and the
  coordination-owned consecutive-failure/pause fields from `target_json` to
  typed columns. Leave execution context, notification routes and access
  requirements in JSON.
- Add atomic create/transition methods guarded by expected state and dedupe key;
  increment attempts/counters in SQL. Make malformed/unknown state fail closed,
  never silently claimable. Keep scheduler execution on `run_leases`.
- Delete JSON builders/parsers/readers for promoted fields and search for every
  legacy snake/camel key before declaring cutover complete. No compatibility
  reader or old-state migration is required in early-stage Gantry.
- Verification: concurrent recovery and terminal job update preserve both
  facts; one active dedupe key; malformed state cannot execute; retry threshold
  cannot lose an increment; invariant 18.

### Stage 8 — Durable IPC interaction ingress and backpressure

- Add a durable per-request ingress/work row and persistent per-folder/lane scan
  cursor. The filesystem request is renamed/validated, accepted into Postgres
  idempotently, then removed; it is not archived merely because execution
  capacity is full.
- Claim accepted work through the primitive. Capacity is fair per lane and
  source agent with an explicit global ceiling. At capacity, release/defer the
  row. Ignored processing/temp/non-JSON files do not consume the bounded scan
  budget; invalid/flood input is rejected at ingress with a durable reason.
- Permission/question deadline semantics remain interaction-owned. Preserve the
  durable prompt-before-render rule and response-file idempotency. Remove the
  global interaction Set only after restart/two-worker tests pass.
- Verification: cursor starvation, one-agent flood fairness, restart at every
  file/DB handoff, duplicate filename/request ID, capacity defer (no archive),
  expired question/permission behavior; invariant 19.

### Stage 9 — Retention, gated adjacent slice (not a primitive consumer)

- **Decision gate before code:** lock data classes and windows, legal/audit
  exclusions, batch size, and the agentless system-principal representation.
  The review's proposed targets conflict: shipped notes say job-backed history
  means `agent_runs`, not `job_runs`, and warn that ordinary agent
  materialization must not create `agent:system`
  (`docs/architecture/arch-quick-wins-assumptions.md:8-10`).
- Once locked, run retention as an ordinary scheduler maintenance job protected
  by existing `run_leases`; do not create another generic claim. Delete bounded
  batches only when no active lease references the run/work, emit audit counts,
  and make replay idempotent.
- If those product/security decisions are not available when Stage 8 closes,
  split retention into its own goal rather than silently choosing policy.
- Verification: live/recoverable runs survive; boundary timestamps; cascading
  references; restart mid-batch; no interactive agent/workspace creation;
  invariant 20.

## Invariant test contract (write 1-8 in Stage 1; add consumer invariants before each migration)

1. Two concurrent claims for one `(workKind, workId)` produce exactly one active
   winner.
2. Every reclaim after release/expiry has a strictly greater fencing version;
   tokens are globally unique.
3. Renew succeeds only for the current active token/owner/fence and extends
   expiry monotonically; a stale owner cannot renew.
4. Release is fenced and idempotent, restores claimability, and never changes
   the consumer's business outcome.
5. Expiry is fenced/idempotent; one expired generation can be reclaimed once,
   and the old generation can no longer write.
6. Same token/fence/outcome settlement is idempotent; conflicting outcome,
   owner, token or fence refuses.
7. Consumer state writes test the active generic fence in SQL. A crash after the
   consumer write but before generic settlement is repaired by replay without
   duplicating the effect.
8. The generic table stores no payload, retry counter, due time, consumer error,
   receipt or domain-specific outcome.
9. Admission/capacity is separate from ownership: losing capacity creates no
   claim, and losing a claim releases capacity.
10. A consumer's expiry policy is explicit and tested; there is no shared
    "expired means retry" default.
11. Async task backlog/scoped admission remains single-winner across processes;
    no local fallback exists.
12. Callable follow-up is discoverable regardless of task age and yields one
    deterministic live-admission message across every crash point.
13. Live admission preserves FIFO/idempotency/defer/failure semantics while a
    stale claimant cannot settle.
14. Toolchain, dream and embedding-backfill heartbeats prevent live work from
    being reaped; a lost fence drops late artifact/dream/backfill terminal writes.
15. Outbound expiry after possible provider dispatch becomes ambiguous, never a
    blind full retry; multipart retry-tail ordering remains unchanged.
16. Required `send_message` persists/claims before provider dispatch and fails
    closed when durability is unavailable.
17. A3 canonical content hashing is order-independent; one open review exists
    per exact scope/content across restart and multiple workers.
18. Jobs recovery and failure counters transition by column CAS; malformed state
    fails closed and concurrent unrelated updates are not lost.
19. IPC capacity defers valid accepted work without archiving it; bounded scans
    cannot starve later valid files and one agent cannot consume all capacity.
20. Retention never deletes live/recoverable work, is batch-idempotent, and runs
    without materializing an ordinary user-facing agent.

## Surface Impact Matrix

| Surface                      | Classification       | Decision                                                                                                                                                                           |
| ---------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed              | Claim/recovery for named consumers, callable follow-up, A3 dedup, jobs CAS and IPC backpressure change by stages above.                                                            |
| `settings.yaml`              | Unchanged by design  | No new runtime tuning knobs. Retention cannot begin until policy is locked; if policy is configurable, revise this matrix and use the full settings-authority path before Stage 9. |
| Postgres/runtime projection  | Changed              | New durable-work and follow-up/IPC rows, consumer claim-column deletion, A3 hash/index, and jobs recovery columns require explicit migrations and throwaway-DB tests.              |
| Control API                  | Read-only/observable | Existing job/webhook/task status must continue to project truthful domain state; no new mutation endpoint is required.                                                             |
| SDK/contracts                | Unchanged by design  | No public tool request/response vocabulary or provider contract changes.                                                                                                           |
| CLI                          | Unchanged by design  | No command or option is introduced; retention configuration is deliberately not guessed.                                                                                           |
| Gantry MCP tools/admin skill | Unchanged by design  | No new authority or admin mutation surface; existing task/job status remains readable.                                                                                             |
| Channel/provider adapters    | Unchanged by design  | Providers continue to send/render; durable outbound and interaction services change below the adapter boundary.                                                                    |
| Docs/prompts                 | Changed              | This goal prompt is the execution contract; update architecture verification docs only if a stage adds a new standard command.                                                     |
| Audit/events                 | Changed              | Claim/reclaim/expire/settle and retention counts need bounded, non-secret operational/audit evidence using existing runtime-event conventions.                                     |
| Tests/verification           | Changed              | Add the invariant suite, per-consumer crash/concurrency integration tests, schema gates, zero-hit cleanup searches, `tsc`, unit/integration and runtime smoke at closeout.         |

## Cleanup proof required at each cutover

Search old schema/type/entrypoint names before completing the owning stage:
`claim_token`, `claim_owner`, `claim_expires_at`, async `leaseToken` /
`fencingVersion` / `heartbeatAt`, `queuedCompactions`,
`createTaskWithLocalAdmission`, `callableAgentFollowUp`,
`recoverPendingDelegatedAgentFollowUps`,
`pendingRequestOnlyCapabilityReviews`, `pendingSkillInstallCommandReviews`,
`pendingSkillPackageReviews`, recovery-intent JSON keys, and
`inFlightInteractionIpc`. Every remaining hit must be a different retained
authority, a migration snapshot, or have an owner/reason/removal condition.

## Non-goals

- No rewrite of `run_leases`, live-turn execution authority, scheduler run
  fencing, `run_slots`, permission decision settlement, or job-trigger binding.
- No universal queue, generic payload JSON, shared retry schedule, or generic
  expiry outcome. Pg-boss remains an adapter queue; provider/HTTP retry loops
  remain at their owned boundaries.
- No folding of transactional event-outbox fan-out, file/skill resource version
  serialization, browser snapshot fencing, local GroupQueue scheduling, memory
  maintenance callbacks, scheduler sync coalescing, or presentation-only Sets.
- No canonical-JSON serializer merge in this cycle. The two serializers have
  different `undefined` semantics and the audit found no active bug
  (`docs/architecture/coordination-representation-audit-2026-07-18.md:175-181`);
  merging them while defining A3 identity risks changing signed/hash inputs.
- No normalization of delegated-task steering CAS loops or parent-task lookup in
  this cycle. Removing follow-up flags does not make unrelated task correlation
  data a work claim.
- No settings/API/CLI/MCP surface for tuning leases. Timeouts remain owned by
  their workload until a separately validated product need exists.
- No compatibility shim or old-state migration fidelity. Gantry has no live
  users; each replacement removes obsolete schema, code, tests and wiring in
  the same stage.
- No retention implementation before Stage 9's explicit policy/security gate.
