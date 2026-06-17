# Boondi/Gantry Warm Pool And Routing Architecture Plan

Date: 2026-06-17

Status: implementation-ready architecture plan. This document replaces the
previous running notes. It records the code-grounded baseline, the target HLD,
and a dependency-ordered phased implementation plan.

Code remains the source of truth. If implementation discovery finds that this
plan contradicts the current code, the plan must be corrected before the
implementation proceeds.

This is also a living execution record. When a phase is completed, update this
document before starting the next phase. Keep checkpoint evidence in the phase
section or in a linked note so later implementation does not depend on memory or
chat history.

Primary objective: minimize user-facing reply latency while making the runtime
production-scalable. Every change in this plan must be evaluated through that
lens. If a change adds coordination, persistence, observability, safety, or
scaling machinery, it must either reduce latency directly, prevent latency
regressions under load, or make horizontal scaling safe without adding avoidable
hot-path work.

## Scope

This plan covers the latency-sensitive Boondi path running on Gantry:

```text
Inbound Interakt webhook -> persisted message -> conversation ownership ->
worker/LLM processing -> durable outbound response -> admin observability
```

The dev implementation definition of done is that
`docs/BOONDI-E2E-TESTING.md` runs cleanly in dev mode and the path from inbound
webhook to outbound response works with minimal avoidable latency.

Production readiness requires more than the dev E2E run. The production gate is
not satisfied until the multi-instance ownership, missed notification recovery,
stale-owner fencing, overload behavior, graceful shutdown, outbound idempotency,
provider rate-limit behavior, and admin observability checks in Phase 8 pass.
Those checks must demonstrate both correctness and latency behavior under
concurrency.

Non-goals for the first implementation:

- Redis as a required dependency. Postgres remains the coordination source of
  truth. Redis can be revisited later only as a wakeup accelerator.
- Phone-number-aware load balancer routing. Any Gantry instance may receive an
  Interakt webhook.
- Replacing existing durable message/outbound primitives that already work.
  The plan extends them with ownership, fencing, and observability.

## Code-Grounded Baseline

These claims are based on the current codebase and should be treated as the
starting point for implementation.

### Current webhook path

- `apps/core/src/control/server/routes/interakt-webhook.ts` verifies the HMAC,
  ACKs with HTTP 200, and then uses `setImmediate` to process the parsed
  webhook asynchronously. The webhook ACK is already out of the processing hot
  path.
- `apps/core/src/channels/interakt/channel.ts` normalizes Interakt text messages
  into Gantry `NewMessage` records. It maps the provider message id to both
  `id` fallback material and `external_message_id`.
- `docs/BOONDI-E2E-TESTING.md` defines the dev end-to-end path:
  Interakt webhook on core port 4710, Gantry processing, Shopify MCP on 8081,
  Boondi CRM MCP on 8082, dry-run outbound, and boondi-admin on 3000.

### Current inbound persistence and dedupe

- `apps/core/src/adapters/storage/postgres/schema/messages.ts` has
  `external_message_id`, `ingress_at`, `send_started_at`, and
  `send_completed_at`.
- The same schema defines a unique index over provider, provider connection,
  conversation, thread, and `external_message_id` when
  `external_message_id IS NOT NULL`.
- `apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts`
  reuses the existing message id when a provider redelivery has the same
  `external_message_id`. Inbound provider redelivery dedupe exists at storage
  level.

### Current routing behavior

- Boondi settings already express the product intent:

  ```yaml
  providers:
    interakt:
      enabled: true
      default_agent: boondi_support
  ```

- `apps/core/src/app/bootstrap/channel-persistence-handlers.ts` now resolves
  Interakt direct routing in this order: explicit persisted route, flagged
  `wa:*` template route, then `providers.interakt.default_agent` as a live
  virtual route.
- The provider `default_agent` path no longer persists a
  `wa:<number> -> boondi_support` route row for every normal Boondi customer.
  Template routes still intentionally clone and persist a per-customer route
  because they are explicit route materialization sources.

### Current wakeup and queue behavior

- `apps/core/src/runtime/group-queue.ts` is an in-process scheduler. It is not a
  durable message queue.
- Its responsibilities are local admission control, one active run per
  conversation/thread key, retry/backoff, active-run continuation routing, and
  shutdown/stop coordination.
- Messages are durable in Postgres. `GroupQueue` stores lightweight scheduling
  state and calls processing code that reads messages from Postgres by cursor.
- `apps/core/src/app/bootstrap/channel-persistence-handlers.ts` wakes processing
  locally after persistence only when the runtime message-store result is not
  `duplicate_existing_message`. It may use an event-pipe debounce, but it is not
  a distributed Postgres conversation notification.
- `apps/core/src/runtime/message-loop.ts` has `recoverPendingMessages`, which
  scans for messages after cursors at startup/recovery and enqueues local
  `GroupQueue` work. This is useful recovery, but it is not the full horizontal
  missed-notification reconciler needed by this plan. Phase 5 now adds a
  separate periodic owner-aware reconciler for pending messages and expired or
  draining owner leases.

### Current warm pool behavior

- `apps/core/src/adapters/llm/anthropic-claude-agent/warm-pool.ts` has a warm
  pool path for runner/process readiness.
- Current warm pool meaning is local worker readiness:
  Node child process, Claude SDK runner initialization, MCP/tool projection, and
  IPC bind readiness.
- Prompt-cache prewarm now has a provider-neutral readiness status on warm
  worker handles. `prewarmCaches()` is called only when
  `runtime.warm_pool.cache_prewarm_enabled` is true.
- The active Anthropic SDK warm path can emit a customer-free
  `cache_prewarm` trace payload from the runner's `startup({ options })`
  boundary when `GANTRY_TRACE_PAYLOADS=1`.
- The current pooled run path should be treated carefully during
  implementation because terminal-output resolution can release the pooled
  worker after a reply instead of keeping it conversation-owned until idle
  timeout.

### Current outbound durability

- `apps/core/src/app/bootstrap/channel-wiring.ts` sends live provider messages
  through `sendProviderMessageInternal`.
- For required durable sends, runtime creates a durable outbound delivery before
  provider send. If durable delivery initialization fails, provider send is
  refused.
- `apps/core/src/app/bootstrap/runtime-services.ts` uses
  `live-send:<sourceMessageId>` as the live-send idempotency key.
- `apps/core/src/adapters/storage/postgres/schema/outbound-delivery.ts`,
  `apps/core/src/adapters/storage/postgres/repositories/outbound-delivery-repository.postgres.ts`,
  and `apps/core/src/jobs/outbound-delivery-recovery.ts` already implement
  durable outbound delivery, claims, receipts, and recovery.
- The missing layer is conversation-owner fencing before customer-visible
  provider send in a horizontally scaled runtime.

### Current observability

- `apps/core/src/runtime/reply-trace.ts` already models sections such as
  `queue`, `guardrail`, `startup`, `llm`, `tool`, `send`, `command`, and `gap`.
- `apps/core/src/runtime/reply-trace-persist.ts` persists reply traces
  best-effort after the customer reply path. It swallows trace persistence
  failures and does not block the reply.
- The Anthropic runner in
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`
  captures turn input/output only when trace payloads are enabled, and records
  cache read/write token counts from model usage.
- Warm prewarm payload capture is now taken from the Anthropic runner's
  `startup({ options })` SDK boundary. Live turn input/output capture still
  comes from the runner turn accumulator and should not be treated as a full
  serialized Claude SDK request object.
- The boondi-admin repo lazy-loads heavy trace payloads:
  `/Users/caw-d/Desktop/boondi-admin/lib/gantry-control.ts`,
  `/Users/caw-d/Desktop/boondi-admin/app/api/trace/route.ts`,
  `/Users/caw-d/Desktop/boondi-admin/lib/types.ts`, and
  `/Users/caw-d/Desktop/boondi-admin/components/LatencyReport.tsx` fetch exact
  payloads only through `/api/trace` when a stage is expanded. The server route
  proxies to the Gantry Control API instead of selecting `payloads_json`
  directly from Postgres.
- `/Users/caw-d/Desktop/boondi-admin/e2e/latency-report.spec.ts` already tests
  that payloads are not fetched until expansion.

### Current ownership state and remaining gaps

- Phase 3 now adds the distributed conversation-owner lease table/service.
- Phase 4 adds the owner `lease_version` fence surface before
  customer-visible outbound provider send, but Phase 5 still needs to thread
  claimed ownership tokens into every processing and recovery path.
- Phase 5 now adds the dedicated conversation-message Postgres `LISTEN/NOTIFY`
  channel with ownership hints and an owner-aware reconciler.
- Runtime startup `recoverPendingMessages()` now goes through distributed
  owner-claim admission before local `GroupQueue` enqueue.
- Full live-turn SDK request serialization is not required for the current
  Anthropic-only prewarm scope; if it becomes necessary, add it at the runner
  SDK query boundary with the same trace-payload controls.

## High-Level Design

### Target architecture

```mermaid
flowchart TD
  A["Interakt webhook"] --> B["Core HTTP route verifies HMAC"]
  B --> C["ACK 200 immediately"]
  B --> D["Async webhook handling"]
  D --> E["Normalize provider message"]
  E --> F["Persist message in Postgres with provider message id"]
  F --> G{"Duplicate provider message?"}
  G -- "yes" --> H["Record dedupe diagnostic and stop wakeup"]
  G -- "no" --> I["Resolve route"]
  I --> J{"Explicit route?"}
  J -- "yes" --> K["Use explicit agent binding"]
  J -- "no" --> L{"Provider default_agent?"}
  L -- "yes" --> M["Use virtual default-agent route"]
  L -- "no" --> N["Drop/reject with diagnostic"]
  K --> O["Claim/read conversation owner lease"]
  M --> O
  O --> P["Publish Postgres NOTIFY doorbell"]
  P --> Q["All instances receive notification"]
  Q --> R{"Am I owner or can I claim?"}
  R -- "no" --> S["Ignore locally"]
  R -- "yes" --> T["Enqueue local GroupQueue"]
  T --> U["Load messages since cursor from Postgres"]
  U --> V{"Bound worker alive for conversation?"}
  V -- "yes" --> W["Reuse sticky worker"]
  V -- "no" --> X["Acquire generic warm worker"]
  X --> Y["Bind worker to conversation until idle timeout"]
  W --> Z["Run guardrail, LLM, tools"]
  Y --> Z
  Z --> AA["Verify lease_version fence"]
  AA --> AB{"Fence valid?"}
  AB -- "no" --> AC["Do not send; release/retry under current owner"]
  AB -- "yes" --> AD["Create durable outbound attempt"]
  AD --> AE["Send Interakt reply or dry-run"]
  AE --> AF["Settle delivery, cursor, session id, trace"]
  AF --> AG["Admin latency/cache views"]
```

### Responsibilities

Postgres is the coordination and durability source of truth for:

- inbound messages and provider message ids;
- conversation cursors;
- provider SDK session ids;
- durable outbound deliveries;
- conversation owner leases;
- lease expiry, heartbeat, and takeover state;
- per-instance runtime health and worker inventory snapshots;
- reply latency traces and optional heavy payload diagnostics.

Each Gantry instance owns only local runtime resources:

- an available pool of generic warm workers;
- conversation-bound sticky workers for conversations it currently owns;
- local `GroupQueue` scheduling state;
- local timers for worker idle cleanup and owner lease heartbeat.

`LISTEN/NOTIFY` is a doorbell only. It wakes instances quickly, but the actual
message, cursor, route, and lease state are always read from Postgres when
correctness matters.

### Persistence, lease, and notification ordering

The fast path must have a deterministic commit order:

```text
begin transaction
  insert or dedupe inbound message
  resolve route enough to know whether conversation work is valid
  claim/read conversation owner lease when needed
  call pg_notify with message id and owner hint
commit transaction
```

Postgres delivers `pg_notify` only after the transaction commits, so listeners
must never see a notification for a message that is not yet visible. If the
transaction rolls back, the notification must not be delivered.

If the implementation cannot keep all four steps in one transaction, it must use
an outbox-style table in the same transaction as message persistence and have a
separate publisher drain committed outbox rows. Do not publish a notification
before the inbound message and dedupe result are committed.

Duplicate provider redelivery should commit only dedupe diagnostics and should
not publish a normal processing wakeup unless the evidence audit proves a
specific recovery case needs it.

### Owner lease data contract

Use an explicit non-null `thread_key` column instead of a nullable unique
`thread_id`. Postgres unique indexes do not treat multiple `NULL` values as
equal, and the project guidance already warns that Drizzle expression upserts
need careful handling. A stored key avoids both problems.

```text
conversation_owner_leases

app_id text not null
conversation_id text not null
thread_id text null
thread_key text not null      # empty string for root/no thread
owner_instance_id text not null
worker_id text null
lease_version bigint not null
lease_expires_at timestamptz not null
heartbeat_at timestamptz not null
state text not null           # active | draining
last_claim_reason text null
last_error text null
draining_started_at timestamptz null
created_at timestamptz not null
updated_at timestamptz not null

unique(app_id, conversation_id, thread_key)
index(lease_expires_at)
index(owner_instance_id, state)
```

Required operations:

```text
claimLease(appId, conversationId, threadId, instanceId, ttl)
heartbeatLease(appId, conversationId, threadId, instanceId, leaseVersion, ttl)
verifyLeaseVersion(appId, conversationId, threadId, instanceId, leaseVersion)
markDraining(instanceId)
releaseLease(appId, conversationId, threadId, instanceId, leaseVersion)
findExpiredOrUnownedWork(limit)
```

Every processing attempt carries the `lease_version` it claimed. Before a
customer-visible provider send, runtime verifies that the current owner and
version still match. This prevents a stale instance from double-sending after
another instance has taken over.

Heartbeat must not increment `lease_version`. Only an ownership change or
intentional takeover increments `lease_version`.

### Notification payload

```json
{
  "app_id": "default",
  "conversation_id": "wa:000964424411",
  "thread_id": null,
  "message_id": "...",
  "owner_instance_id": "server-b",
  "lease_version": 42,
  "lease_expires_at": "2026-06-17T12:30:00.000Z"
}
```

Fast path:

```text
payload owner is another instance and lease is clearly valid -> ignore locally
payload owner is me -> enqueue local GroupQueue
payload has no owner / expired owner / stale version -> attempt Postgres claim
```

Production constraints:

- each Gantry instance must use a dedicated non-transaction-pooled Postgres
  connection for `LISTEN`;
- PgBouncer transaction pooling must not be used for the listener connection;
- listeners must reconnect and resubscribe after connection loss;
- payloads must stay small and contain identifiers/hints only, never full
  messages or prompt payloads;
- listener lag, reconnects, and missed-notification recovery must be observable;
- the reconciler is mandatory because notifications are not durable work items.

### Worker lifecycle contract

```text
available warm pool size = X

server starts X generic unbound workers
customer arrives and owner lease is held locally
-> acquire generic worker
-> bind worker to conversation
-> immediately replenish generic pool back toward X
-> keep bound worker until worker_idle_timeout after last activity
-> destroy bound worker on idle expiry; do not return it to generic pool
```

Bound workers are sticky only to one conversation/thread. They are never reused
for another customer.

Separate clocks:

| Clock                 | Meaning                                                               | Initial target |
| --------------------- | --------------------------------------------------------------------- | -------------- |
| `worker_idle_timeout` | How long a conversation-bound worker stays alive after last activity. | 30 minutes     |
| `lease_ttl`           | How long other servers trust an owner without heartbeat.              | 30-60 seconds  |
| `heartbeat_interval`  | How often the owner extends its lease while active/draining.          | 5-10 seconds   |

### Cache observability contract

The admin panel must show exact cache input and output, but this must not add
latency to the customer reply.

Target approach:

- capture cache payloads only when payload tracing is enabled by admin/dev
  configuration, disabled by default in production;
- capture at the provider adapter and cache-prewarm boundary, where the actual
  cacheable prompt/probe shape is known;
- persist heavy payloads through the existing `message_traces.payloads_json`
  style or a trace-artifact table after the reply/prewarm completes;
- lazy-load payloads in boondi-admin only when the operator expands a stage;
- never store provider credentials, signing secrets, or MCP secret values in
  payload traces;
- enforce payload size limits and retention;
- require admin-only access and audit reads of exact payloads;
- redact secrets and high-risk tokens before persistence;
- document whether customer PII may appear in exact payloads and how long it is
  retained.

The cache trace shape should include:

```json
{
  "cache": {
    "provider": "anthropic",
    "modelAlias": "sonnet",
    "promptShapeKey": "provider+agent+model+tools+promptVersion",
    "cacheReadTokens": 0,
    "cacheWriteTokens": 9085,
    "input": {},
    "output": {},
    "capturedAt": "2026-06-17T12:30:00.000Z"
  }
}
```

The `input` and `output` fields are intentionally `unknown` JSON payloads in the
plan because the exact SDK adapter shape must be captured from the real
provider boundary during implementation.

### Worker observability contract

The admin dashboard must show warm-worker and active-worker inventory per
runtime instance. In local dev there is one instance, but the data model must be
multi-instance from the start so it still works after AWS horizontal deployment.

Target snapshot shape:

```json
{
  "instanceId": "local-dev",
  "hostname": "developer-machine",
  "startedAt": "2026-06-17T12:00:00.000Z",
  "lastHeartbeatAt": "2026-06-17T12:30:00.000Z",
  "warmPool": {
    "availableTarget": 3,
    "genericAvailable": 3,
    "genericStarting": 0,
    "boundActive": 2,
    "boundIdle": 1,
    "boundDraining": 0,
    "maxBoundWorkers": 100
  },
  "queue": {
    "activeMessageRuns": 2,
    "pendingConversationKeys": 4,
    "maxMessageRuns": 3
  }
}
```

This should be reported through a runtime snapshot/heartbeat table or equivalent
central read model, not by requiring boondi-admin to directly call every app
server. The local deployment will simply have one row. In AWS, every Gantry
instance writes its own row, and stale rows are hidden or marked unhealthy based
on `lastHeartbeatAt`.

Worker inventory snapshots are best-effort observability, not scheduling truth.
They must be low-rate per-instance summary writes, not one Postgres write per
worker transition. Initial production target:

```text
heartbeat interval: 5-10 seconds
stale threshold: 3 missed heartbeats
cleanup: periodically hide or delete rows older than the retention window
```

Scheduling and correctness must continue to rely on owner leases, queue state,
and durable messages, not dashboard snapshots.

### External side effects and fencing

Provider sends are not the only side effect. Tool calls must be classified:

| Tool class           | Examples                                                         | Required protection                                                |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| Read-only            | Search order, fetch customer profile, read inventory             | Normal run ownership and traceability.                             |
| Idempotent write     | Upsert lead note with idempotency key                            | Current lease check plus external idempotency key.                 |
| Non-idempotent write | Create order, refund, send message, mutate CRM state without key | Block until an idempotency strategy and current lease fence exist. |

Before production, any tool that can mutate external state must declare its side
effect class. Stale owners must not be allowed to perform non-idempotent external
mutations merely because provider-send fencing happens later.

Durable outbound recovery is also a side-effecting path. Recovery sends must
verify current ownership, or explicitly rebind the recovery attempt under the
current owner before dispatch.

## Phased Implementation Plan

### Execution Tracking Rules

Every phase must keep a small checkpoint block while implementation is in
progress:

```text
Status: Not started | In progress | Completed | Blocked
Checkpoint owner:
Started:
Completed:
Evidence:
  - code references changed or verified
  - tests run
  - latency/behavior observations
  - scaling/concurrency observations
  - hot-path work added or removed
  - decisions made
Open follow-ups:
  - ...
```

Rules:

- Do not mark a phase completed until its acceptance criteria are satisfied or
  explicitly revised with evidence.
- Before moving to the next phase, update this document with the completed
  phase result, test commands, latency/scaling observations, and any plan
  corrections discovered.
- Every phase must explicitly state whether it adds work to the user-facing hot
  path. Added hot-path work requires a justification and a latency measurement
  or bounded estimate.
- If a later phase invalidates an earlier assumption, update the earlier phase
  checkpoint and the affected future phase before continuing.
- Keep checkpoints concise. The goal is durable execution state, not a second
  implementation log.

### Phase 0 - Evidence TODOs and plan validation

Checkpoint:

```text
Status: Completed
Checkpoint owner: Codex
Started: 2026-06-16T23:37:33Z
Completed: 2026-06-16T23:37:33Z
Evidence:
  - `python3 .codex/scripts/stage_orchestrator.py` could not run in this
    linked worktree because `.codex/scripts/` is absent.
  - Current routing, queue, warm-pool, trace, outbound, and config paths were
    audited by line-numbered source reads.
  - The current code still materializes `providers.interakt.default_agent` into
    per-customer route rows; Phase 2 remains required.
  - Trace persistence is already best-effort, but operational section kinds
    from Phase 1 are not present yet.
  - Owner leases, outbound owner fencing, dedicated conversation NOTIFY, and a
    horizontal reconciler are not present yet.
  - `GANTRY_SPIKE_*` warm-pool scaffolding is absent in this worktree; the
    remaining cleanup candidates are runtime env switches with mixed ownership.
Resolved by later phases:
  - Phase 1 extended operational section kinds while keeping trace persistence
    best-effort.
  - Phase 2 replaced default-agent route materialization with live virtual route
    projection.
  - Phase 8 moved warm-pool/cache-prewarm/runner retention behavior to
    settings-owned fields and proved legacy env switches are ignored.
```

#### Summary (plain English)

Before changing behavior, run the discovery TODOs and turn the results into an
evidence packet. The implementation plan should be supported by measured code
facts, not assumptions. If the evidence contradicts any part of this document,
update the plan first and only then continue.

#### Detailed step-by-step plan & procedure

1. Build an evidence matrix for the current code path. Each row should contain:

   ```text
   topic
   current behavior
   source file and line/function reference
   tests that already cover it
   gap or risk
   decision supported by this evidence
   ```

2. Audit the existing routing path:
   - exact route lookup;
   - Interakt `default_agent` fallback;
   - per-number route materialization;
   - startup route prewarm behavior;
   - tests covering default-agent routing.

3. Audit the existing queue and wakeup path:
   - where inbound messages are persisted;
   - when local `GroupQueue` is woken;
   - what the event pipe does today;
   - where `recoverPendingMessages` scans from durable state;
   - whether duplicates still trigger unnecessary wakeup work.

4. Audit the existing warm-pool lifecycle:
   - worker states currently represented in code;
   - when a pooled worker is acquired;
   - when it is released;
   - whether terminal output currently releases the worker;
   - how `IDLE_TIMEOUT` is actually used.

5. Audit the existing prompt-cache and payload trace behavior:
   - what `prewarmCaches()` does today;
   - what `GANTRY_WARM_POOL_CACHE_PROBE` actually enables;
   - what payloads the Anthropic runner captures today;
   - whether current payload capture includes the exact cacheable SDK input;
   - whether trace persistence can block a reply.

6. Audit existing outbound durability and dedupe:
   - inbound provider redelivery dedupe;
   - durable outbound idempotency key;
   - outbound claim/receipt behavior;
   - recovery behavior after ambiguous send settlement;
   - where a future owner-lease fence must be inserted;
   - whether outbound recovery can send without rechecking current ownership.

7. Audit admin observability:
   - current latency sections;
   - lazy payload fetch behavior;
   - current `/api/trace` shape;
   - where worker inventory can be read without per-server fan-out;
   - current admin access controls for exact payload visibility;
   - payload retention and redaction behavior.

8. Audit configuration ownership:
   - `.env` keys currently used for warm pool, queue, trace, outbound dry-run,
     idle timeout, and model/provider behavior;
   - `settings.yaml` runtime keys currently supported;
   - code defaults such as `maxMessageRuns`;
   - dead or duplicate switches.

9. Audit production deployment constraints:
   - whether the intended AWS Postgres access path uses PgBouncer or another
     pooler;
   - whether a dedicated listener connection can bypass transaction pooling;
   - expected app instance identity source;
   - clock skew assumptions for lease expiry and heartbeat;
   - provider credential capacity for live turns and cache prewarm.

10. Produce a short evidence report in this document or a linked architecture
    note. The report must explicitly state:

- confirmed findings;
- incorrect assumptions found;
- unresolved questions;
- plan changes required before Phase 1;
- test commands used.

11. Update the later phases if the evidence changes the design. Examples:
    - if `IDLE_TIMEOUT` is not the right bound-worker TTL, define a new setting
      with justification;
    - if current trace payloads already include exact cache input, simplify
      Phase 7;
    - if `storeMessage()` can already distinguish duplicate inserts, avoid a
      repository contract change.

#### Acceptance criteria (plain English)

- The plan has a code-referenced evidence matrix before implementation starts.
- Every major claim used by later phases is backed by a file/function reference
  or explicitly marked unresolved.
- Dead env/config switches are identified before new switches are added.
- Any contradiction between the plan and the code is resolved in the plan before
  Phase 1 begins.
- The evidence report lists the verification commands used and their results.

#### Evidence report

Verification commands used:

```bash
sed -n '1,260p' README.md
sed -n '1,240p' WORKFLOW.md
sed -n '1,260p' docs/FACTORY.md
sed -n '1,260p' docs/QUALITY.md
sed -n '1,260p' docs/architecture/codebase-refactor-principles.md
sed -n '1,320p' docs/architecture/current-verification-commands.md
python3 .codex/scripts/stage_orchestrator.py
rg -n "GANTRY_SPIKE_|SPIKE_|warm-pool-spike|WarmQuery single-use verified|env fast-path|GANTRY_WARM_POOL_CACHE_PROBE|GANTRY_WARM_POOL\b|IDLE_TIMEOUT\b" apps/core/src apps/core/test scripts docs/architecture/warm-pool-routing-findings-and-todos.md -S
```

Results:

- The mandatory docs were readable and reaffirmed the settings/runtime boundary,
  TDD requirement for behavior changes, and final verification gates.
- `python3 .codex/scripts/stage_orchestrator.py` failed because this linked
  worktree has no `.codex/scripts/` directory. Use
  `docs/architecture/current-verification-commands.md` plus direct test scripts
  in this checkout.
- The cleanup search found no `GANTRY_SPIKE_*`, `SPIKE_`,
  `warm-pool-spike`, `WarmQuery single-use verified`, or `env fast-path`
  matches outside this plan text. The spike scaffolding is already gone in this
  worktree.

Evidence matrix:

| Topic                                       | Current behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Source reference                                                                                                                                                                                                                                                                                                                                                                                            | Existing coverage found                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Gap or risk                                                                                                                                                                                                 | Decision supported                                                                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interakt default-agent routing              | Phase 0 found that new `wa:*` inbound without an existing route still called `registerGroup()` from `providers.interakt.default_agent`; Phase 2 changed this to live `projectConversationRoute()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `apps/core/src/app/bootstrap/channel-persistence-handlers.ts:107-153`                                                                                                                                                                                                                                                                                                                                       | `apps/core/test/unit/bootstrap/channel-wiring.test.ts` now covers the virtual default-agent path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Recovery still needs a durable virtual-route strategy because live projection is in-memory.                                                                                                                 | Phase 5 must account for default-agent routes during reconciliation after restart or missed notification.                                                                                       |
| Interakt startup validation                 | Startup accepts `providers.interakt.default_agent` as a route source and now documents it as live virtual projection. The periodic reconciler can recover pending inbound default-agent conversations from durable inbound message ids and project a live route before queue admission.                                                                                                                                                                                                                                                                                                                                                                                                                                 | `apps/core/src/app/bootstrap/startup.ts:194-260`; `apps/core/src/runtime/conversation-work-reconciler.ts`                                                                                                                                                                                                                                                                                                   | Startup tests cover validation. Reconciler tests cover default-agent conversation recovery from durable inbound conversation ids.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Startup prewarm still only iterates persisted routes.                                                                                                                                                       | Phase 6/7 should prewarm by agent/default route shape rather than only saved customer routes.                                                                                                   |
| Startup warm prewarm                        | Startup iterates only persisted conversation routes and prewarms each route.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `apps/core/src/app/bootstrap/startup.ts:63-77`                                                                                                                                                                                                                                                                                                                                                              | Startup warm-pool tests exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Future default-agent-only customers have no saved route to prewarm.                                                                                                                                         | Phase 2 should not depend on saved routes for future Interakt customers.                                                                                                                        |
| Message persistence and conversation wakeup | `onMessage()` stores the message, publishes a sanitized conversation-work doorbell when configured, and leaves queue admission to the doorbell dispatcher; fallback local wake remains only when no publisher is configured. Duplicate provider redeliveries do not publish or wake. Runtime publication now claims or observes the current owner lease before publishing and includes owner hints in the doorbell payload. Startup recovery now claims distributed ownership before queue admission when the runtime wiring supplies the claim gate. Processing refreshes/claims the lease at customer-visible message-send time and attaches the returned lease version to normal message sends and streaming chunks. | `apps/core/src/app/bootstrap/channel-persistence-handlers.ts:302-347`; `apps/core/src/runtime/conversation-work-notification-publisher.ts`; `apps/core/src/runtime/conversation-work-dispatcher.ts`; `apps/core/src/runtime/conversation-work-reconciler.ts`; `apps/core/src/runtime/message-loop.ts:375-427`; `apps/core/src/runtime/group-processing.ts`; `apps/core/src/app/bootstrap/channel-wiring.ts` | Channel persistence tests cover message persistence, route handling, duplicate wake suppression, doorbell publication, and no direct local wake when a publisher is configured. Owner-claiming publisher tests cover claim-before-notify ordering, owner hints for acquired/lost claims, and fail-closed claim errors. Dispatcher tests cover owner-hint filtering and Postgres owner claim before enqueue. Reconciler tests cover owner-claim admission for recovered work, pending-message candidate discovery, default-agent virtual-route recovery, and stoppable polling. Message-loop tests cover startup recovery claim gating. Group-processing/runtime-app tests cover ownership-token propagation into message sends; group-processing/channel-wiring tests cover streaming ownership fencing and token stripping. MCP trace tests cover explicit `mutationIntent` metadata for unknown raw MCP tool names, ownership checks for side-effecting tool calls, and required idempotency-key arguments before side-effecting proxy execution. | Doorbell publication is still not atomically stored in a transactional outbox with message persistence; MCP runtime verifies that a key argument exists but cannot prove the external MCP server honors it. | Continue Phase 5 transactional/outbox refinement only if stronger missed-notify latency guarantees are required; production capability review must validate external MCP idempotency semantics. |
| Message repository dedupe                   | Canonical message save looks up existing rows by provider/provider connection/conversation/thread/external message id and writes to the existing message id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts:1038-1067`; `apps/core/src/adapters/storage/postgres/repositories/canonical-message-repository.postgres.ts:114-183`; `apps/core/src/adapters/storage/postgres/schema/messages.ts:82-90`                                                                                                                               | Postgres domain tests and canonical ops integration cover redelivery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The runtime-facing contract exposes insert/duplicate/update status and now drives normal doorbell suppression.                                                                                              | Continue Phase 5; do not infer duplicate state from logs.                                                                                                                                       |
| GroupQueue                                  | `GroupQueue` is in-memory local scheduling with concurrency, retry, active-run continuation routing, and shutdown signaling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `apps/core/src/runtime/group-queue.ts:84-122`, `apps/core/src/runtime/group-queue.ts:243-269`, `apps/core/src/runtime/group-queue.ts:490-539`                                                                                                                                                                                                                                                               | `apps/core/test/unit/runtime/group-queue.test.ts` covers queue behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | It is not durable or distributed and must not become ownership truth.                                                                                                                                       | Keep Phase 5 as Postgres doorbell plus lease/reconciler; leave `GroupQueue` local.                                                                                                              |
| Recovery scan                               | Startup/recovery scans persisted messages after per-conversation/thread cursors and now uses the runtime-supplied owner claim gate before local `GroupQueue` enqueue. Phase 5 also added a separate periodic owner-aware reconciler for pending-message candidates, expired/draining lease candidates, and default-agent virtual-route recovery from durable inbound conversations.                                                                                                                                                                                                                                                                                                                                     | `apps/core/src/runtime/message-loop.ts:375-427`; `apps/core/src/runtime/conversation-work-reconciler.ts`                                                                                                                                                                                                                                                                                                    | Message-loop tests cover pending recovery and claim-gated enqueue. Reconciler tests cover pending-message candidate discovery, default-agent conversation recovery, owner-claim admission, and timer shutdown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Startup prewarm still does not prewarm default-agent-only customers before an inbound/reconciler candidate exists.                                                                                          | Phase 6/7 can improve prewarm shape discovery; Phase 5 no longer needs a separate default-agent route recovery item.                                                                            |
| Warm-pool process readiness                 | Warm workers boot generic with empty customer identity and wait for bind readiness; cache-prewarm status is recorded before a worker becomes idle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `apps/core/src/adapters/llm/anthropic-claude-agent/warm-pool.ts:69-123`, `apps/core/src/runtime/warm-pool-manager.ts`                                                                                                                                                                                                                                                                                       | `apps/core/test/unit/adapters/anthropic-warm-pool.test.ts` and `apps/core/test/unit/runtime/warm-pool-manager.test.ts` cover probe status and readiness gating.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Exact admin payload visibility is still deferred.                                                                                                                                                           | Phase 8 must finish admin/E2E gates before production-ready claims.                                                                                                                             |
| Warm bound worker lifecycle                 | A warm worker is acquired and bound, then `executeRunnerProcess()` resolves on terminal output and registers a pooled release. `GroupQueue` releases pooled workers during run teardown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `apps/core/src/runtime/agent-spawn.ts:1079-1187`; `apps/core/src/runtime/group-queue.ts:524-536`                                                                                                                                                                                                                                                                                                            | Warm-pool runner and process tests cover current release behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Current behavior does not prove sticky conversation ownership until idle timeout.                                                                                                                           | Phase 6 must change lifecycle semantics before claiming sticky bound workers.                                                                                                                   |
| Reply trace stages                          | Timeline sections currently include `queue`, `guardrail`, `startup`, `llm`, `tool`, `send`, `command`, and `gap`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `apps/core/src/runtime/reply-trace.ts:200-208`                                                                                                                                                                                                                                                                                                                                                              | Reply-trace tests cover assembly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Operational stages such as notify, lease, fence, cache prewarm/use are not representable yet.                                                                                                               | Phase 1 should extend section kinds and admin rendering first.                                                                                                                                  |
| Trace persistence hot path                  | `persistReplyTrace()` assembles/saves after reply and catches all failures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `apps/core/src/runtime/reply-trace-persist.ts:66-120`                                                                                                                                                                                                                                                                                                                                                       | Trace persistence failure tests exist and should be extended.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Good baseline; avoid adding blocking writes.                                                                                                                                                                | Phase 1 must preserve best-effort persistence.                                                                                                                                                  |
| Outbound durability                         | Required sends create a durable outbound attempt before provider send; provider-visible post-send settlement failures become ambiguous/non-retryable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `apps/core/src/app/bootstrap/channel-wiring.ts:413-437`, `apps/core/src/app/bootstrap/channel-wiring.ts:572-620`                                                                                                                                                                                                                                                                                            | Outbound delivery unit/integration coverage exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | No current owner `lease_version` check before provider send.                                                                                                                                                | Phase 4 must add fencing without replacing durable idempotency.                                                                                                                                 |
| Outbound recovery                           | Recovery claims pending items and dispatches them through an injected dispatcher.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `apps/core/src/jobs/outbound-delivery-recovery.ts:120-163`                                                                                                                                                                                                                                                                                                                                                  | Outbound recovery tests cover claims/settlement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | No ownership verification before recovery dispatch.                                                                                                                                                         | Phase 4 must fence or rebind recovery dispatch.                                                                                                                                                 |
| Settings-owned queue config                 | `runtime.queue` is parsed, rendered, and exposed through public runtime settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `apps/core/src/config/settings/runtime-settings-parser.ts:684-790`; `apps/core/src/config/settings/runtime-settings-renderer.ts:717-733`; `apps/core/src/config/index.ts:166-175`                                                                                                                                                                                                                           | Config tests cover public runtime settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Queue defaults are settings-owned but hard-coded fallback remains in `GroupQueue` for constructor defaults.                                                                                                 | Phase 8 should document owner and avoid adding env-only queue knobs.                                                                                                                            |
| Warm-pool settings                          | `runtime.warm_pool.enabled`, `size`, `idle_ttl_ms`, `max_bound_workers`, `cache_prewarm_enabled`, and `cache_prewarm_concurrency` are settings-owned. Legacy `GANTRY_WARM_POOL` no longer force-enables the pool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `apps/core/src/config/settings/runtime-settings-types.ts:225-236`; `apps/core/src/config/index.ts:177-187`; `apps/core/src/app/bootstrap/runtime-app.ts:180-190`                                                                                                                                                                                                                                            | Config tests cover settings-owned defaults, rendering, parsing, and ignored legacy env.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Live runner retention now has its own settings-owned key, separate from warm-pool generic TTL.                                                                                                              | Phase 8 still needs final E2E/chaos gates.                                                                                                                                                      |
| Idle timeout                                | `runtime.runner.idle_timeout_ms` is settings-owned and controls live runner stdin retention plus the runner hard-timeout backstop. Legacy `IDLE_TIMEOUT` env is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `apps/core/src/config/settings/runtime-settings-types.ts`; `apps/core/src/config/index.ts`; `apps/core/src/runtime/group-processing.ts`; `apps/core/src/runtime/agent-spawn-process.ts`                                                                                                                                                                                                                     | Config tests cover default/render/parse and ignored legacy env; runtime tests stub `RUNNER_IDLE_TIMEOUT_MS`; Boondi setup warns when settings do not match the requested scenario window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The script does not mutate external `~/gantry/settings.yaml`; operators must set the runtime settings key for short Boondi scenario retention.                                                              | Phase 8 still needs final E2E/chaos gates.                                                                                                                                                      |
| Dev diagnostics                             | `GANTRY_FLOW_LOG`, `GANTRY_TRACE_PAYLOADS`, `GANTRY_OUTBOUND_DRYRUN`, test phone overrides, and child-runner-from-source are hydrated from `$GANTRY_HOME/.env`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `apps/core/src/app/index.ts:50-67`; `apps/core/src/shared/flow-log.ts:1-29`; `apps/core/src/app/bootstrap/channel-wiring.ts:351-410`; `apps/core/src/runtime/reply-trace.ts:496`                                                                                                                                                                                                                            | Boondi E2E docs and tests rely on them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | These are not all dead; deleting them would break local verification.                                                                                                                                       | Keep dev/test diagnostics until explicit replacement exists.                                                                                                                                    |

Confirmed findings:

- The target architecture is directionally correct, but implementation must
  start with Phase 1/2, not later ownership phases.
- `settings.yaml` already owns some runtime queue/warm-pool settings, but env
  overrides remain for warm-pool enablement and idle-timeout behavior.
- Trace persistence already satisfies the non-blocking requirement; Phase 1 is
  an additive schema/type/UI expansion.
- There is no evidence of remaining spike-only warm-pool toggles in active code.

Incorrect assumptions found:

- Phase 0 found that `providers.interakt.default_agent` still synthesized and
  persisted routes. Phase 2 updated code and comments to virtual routing.
- The config cleanup cannot happen as a single blind `.env` deletion. Several
  env switches are still deliberate dev/test diagnostics used by the Boondi E2E
  runbook.

Unresolved questions:

- The intended AWS Postgres topology and PgBouncer/listener path are not
  represented in this checkout.
- Provider credential capacity for cache prewarm/live concurrency must be
  measured during Phase 8; it is not derivable from code.

Plan changes required before Phase 1:

- None that block Phase 1. Phase 1 can add section kinds and worker snapshot
  contracts while preserving best-effort trace persistence.

Plan changes required before Phase 2:

- Treat provider default-agent as a virtual route in runtime state, not as an
  implicit desired-state write. Any tests that currently expect
  `registerGroup()` for default-agent fallback must be rewritten to assert no
  persisted route row is created.

Switch audit:

| Switch                                      | Current owner                     | Status                         | Cleanup decision                                                                                         |
| ------------------------------------------- | --------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `runtime.queue.max_message_runs`            | `settings.yaml`                   | Active                         | Keep.                                                                                                    |
| `runtime.queue.max_job_runs`                | `settings.yaml`                   | Active                         | Keep.                                                                                                    |
| `runtime.queue.max_retries`                 | `settings.yaml`                   | Active                         | Keep.                                                                                                    |
| `runtime.queue.base_retry_ms`               | `settings.yaml`                   | Active                         | Keep.                                                                                                    |
| `runtime.warm_pool.enabled`                 | `settings.yaml`                   | Active                         | Keep as desired-state owner.                                                                             |
| `runtime.warm_pool.size`                    | `settings.yaml`                   | Active                         | Keep; later rename/extend to `available_size` only with parser/renderer migration.                       |
| `runtime.warm_pool.idle_ttl_ms`             | `settings.yaml`                   | Active                         | Keep for generic warm-pool maintenance; separate from live runner retention.                             |
| `runtime.runner.idle_timeout_ms`            | `settings.yaml`                   | Active                         | Live runner stdin retention and hard-timeout backstop owner.                                             |
| `runtime.trace.payload_retention_ms`        | `settings.yaml`                   | Active                         | Keep as exact trace payload retention owner; timing rows are preserved.                                  |
| `runtime.trace.payload_cleanup_interval_ms` | `settings.yaml`                   | Active                         | Keep as exact trace payload cleanup cadence owner.                                                       |
| `GANTRY_WARM_POOL`                          | none                              | Removed                        | Legacy env is ignored; use `runtime.warm_pool.enabled`.                                                  |
| `GANTRY_WARM_POOL_CACHE_PROBE`              | none                              | Removed                        | Use `runtime.warm_pool.cache_prewarm_enabled` and `cache_prewarm_concurrency`.                           |
| `IDLE_TIMEOUT`                              | none                              | Removed                        | Legacy env is ignored; use `runtime.runner.idle_timeout_ms`.                                             |
| `GANTRY_FLOW_LOG`                           | `$GANTRY_HOME/.env` / process env | Active dev diagnostic          | Keep for Boondi E2E until trace/admin coverage fully replaces it.                                        |
| `GANTRY_TRACE_PAYLOADS`                     | `$GANTRY_HOME/.env` / process env | Active dev diagnostic          | Keep as disabled-by-default exact payload capture gate; access/policy is now Control API/settings-owned. |
| `GANTRY_OUTBOUND_DRYRUN`                    | `$GANTRY_HOME/.env` / process env | Active dev safety gate         | Keep for local Boondi testing.                                                                           |
| `GANTRY_TEST_OPERATOR_PHONE`                | `$GANTRY_HOME/.env` / process env | Active dev safety scope        | Keep with outbound dry-run.                                                                              |
| `GANTRY_TEST_CALLER_IDENTITY_PHONE`         | `$GANTRY_HOME/.env` / process env | Active Boondi harness override | Keep until test harness has a settings-owned alternative.                                                |
| `GANTRY_CHILD_RUNNER_FROM_SOURCE`           | `$GANTRY_HOME/.env` / process env | Active developer workflow      | Keep; not part of production routing/warm-pool ownership.                                                |
| `GANTRY_SPIKE_*`                            | none found                        | Removed                        | No action in this worktree.                                                                              |

Surface Impact Matrix for the next implementation slice:

| Surface                      | Status               | Reason                                                                                                                                  |
| ---------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed              | Phase 1 adds observable trace kinds; Phase 2 changes default-agent routing from persisted synthetic routes to virtual route resolution. |
| `settings.yaml`              | Read-only/observable | Existing `providers.interakt.default_agent` remains the source; no write is required for Phase 1/2.                                     |
| Postgres/runtime projection  | Changed              | Phase 2 should stop creating route projection rows for new default-agent Interakt customers.                                            |
| Control API                  | Unchanged by design  | No control mutation path is required for Phase 1/2.                                                                                     |
| SDK/contracts                | Unchanged by design  | Cache prewarm and SDK payload contracts are deferred to Phase 7.                                                                        |
| CLI                          | Unchanged by design  | No CLI surface changes are needed for Phase 1/2.                                                                                        |
| Gantry MCP tools/admin skill | Unchanged by design  | No tool authority changes are needed for Phase 1/2.                                                                                     |
| Channel/provider adapters    | Changed              | Interakt inbound routing behavior changes in Phase 2.                                                                                   |
| Docs/prompts                 | Changed              | This plan now records Phase 0 evidence and cleanup decisions.                                                                           |
| Audit/events                 | Changed              | Phase 1 adds pipeline stage names; later phases will populate them.                                                                     |
| Tests/verification           | Changed              | Add/update core unit tests before behavior changes; admin tests follow when UI is edited.                                               |

### Phase 1 - Observability foundation

Checkpoint:

```text
Status: Completed
Checkpoint owner: Codex
Started: 2026-06-17T00:17:41Z
Completed: 2026-06-17T18:05:00+05:30
Evidence:
  - `apps/core/src/runtime/reply-trace.ts` now defines operational timeline
    kinds for webhook ACK, message persistence, dedupe, notify publish/receive,
    lease claim/heartbeat/takeover, outbound fence/recovery, and cache
    prewarm/use.
  - The v2 timeline assembler accepts operational sections, preserves
    stage-indexed payload alignment, and supports typed cache payload envelopes
    without faking cache input/output from partial prompt data.
  - `apps/core/src/runtime/reply-trace-persist.ts` forwards operational
    sections through the existing best-effort persistence path. Save failures
    still remain caught after the reply path.
  - `apps/core/src/runtime/worker-inventory-snapshot.ts` defines the
    provider-neutral worker inventory snapshot/read-model contract for one local
    instance and multiple instances with stale row classification.
  - `GET /v1/runtime/workers` now exposes the local runtime worker inventory
    through the control API using the same provider-neutral summary contract.
    The endpoint reports warm-pool counts, active/pending inbound queue counts,
    and healthy aggregate totals without adding a Postgres write path.
  - Worker inventory now includes aggregate cache-prewarm visibility for the
    runtime-only path: status counts and cache-shape/status buckets are exposed
    without worker ids or exact prompt payloads.
  - Worker inventory now persists a low-rate per-instance heartbeat read model
    in Postgres through `runtime_worker_inventory_snapshots`, keyed by
    `app_id + instance_id`. The read model stores only summary `warm_pool_json`
    and `queue_json` payloads and remains observability-only.
  - `startWorkerInventoryHeartbeat()` writes the local runtime snapshot
    immediately and then at a bounded heartbeat interval. Shutdown stops the
    heartbeat before storage closes.
  - `GET /v1/runtime/workers` now reads all persisted snapshots for the
    authenticated app when the repository is available and still falls back to
    the local process snapshot for isolated tests/degraded diagnostics. Healthy
    totals exclude stale instances using the existing summary classifier.
  - Red checks first:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/reply-trace.test.ts --testNamePattern "operational pipeline"`
    failed because operational sections were ignored;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/reply-trace-persist.test.ts --testNamePattern "operational sections"`
    failed because persistence dropped operational sections;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/worker-inventory-snapshot.test.ts`
    failed because the module did not exist.
  - Green checks for the same commands now pass.
  - Green checks added for the local control API wiring:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/control/system-routes.test.ts`;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/control/openapi.test.ts`;
    `npx tsc --noEmit --pretty false`.
  - Green checks for cache visibility in worker inventory:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/warm-pool-manager.test.ts --testNamePattern "cache prewarm status and shape"`;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/worker-inventory-snapshot.test.ts apps/core/test/unit/bootstrap/runtime-app.test.ts apps/core/test/unit/control/system-routes.test.ts`.
  - Green checks for persisted multi-instance worker inventory:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/control/system-routes.test.ts apps/core/test/unit/runtime/worker-inventory-heartbeat.test.ts apps/core/test/unit/bootstrap/shutdown.test.ts`;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/control/system-routes.test.ts apps/core/test/unit/runtime/worker-inventory-heartbeat.test.ts apps/core/test/unit/bootstrap/shutdown.test.ts apps/core/test/unit/storage/postgres-migration-journal.test.ts --testNamePattern "worker inventory|runtime workers|shutdown order|journal"`;
    `npx tsc --noEmit --pretty false`;
    `GANTRY_TEST_DATABASE_URL=postgres://gantry:gantry@127.0.0.1:55436/gantry_test npx vitest run -c vitest.integration.config.ts apps/core/test/integration/runtime-worker-inventory.postgres.integration.test.ts`
    against disposable Docker Postgres with `vector` and `pg_trgm` extensions.
  - Hot-path impact: no new runtime work is added unless callers explicitly
    supply operational trace spans; trace save remains best-effort and payloads
    remain gated by payload tracing. Worker inventory heartbeat adds one
    per-instance summary write every 5 seconds by default, not one write per
    worker transition.
External/admin follow-ups completed in boondi-admin:
  - `/Users/caw-d/Desktop/boondi-admin/lib/types.ts` now accepts the operational
    section kinds emitted by the v2 Gantry timeline.
  - `/Users/caw-d/Desktop/boondi-admin/components/LatencyReport.tsx` renders
    cache prewarm/use and runtime operational sections, preserves lazy payload
    loading, and can display the cache payload envelope when trace payloads are
    enabled.
  - `/Users/caw-d/Desktop/boondi-admin/app/runtime/page.tsx` and
    `/Users/caw-d/Desktop/boondi-admin/app/api/runtime/workers/route.ts` add a
    Runtime tab that reads `GET /v1/runtime/workers` through a server-side
    proxy, keeping the Control API bearer token out of the browser.
  - Verification:
    `rm -rf .next && npm run build`
  - Verification:
    focused browser E2E run on port 3107 for `e2e/latency-report.spec.ts`
    and `e2e/runtime-workers.spec.ts`.
Remaining follow-ups:
  - None for Phase 1. Exact payload audit, retention cleanup, and production
    auth hardening remain tracked in Phase 7.
```

#### Summary (plain English)

First make the runtime and admin observability contract precise. We already
have reply traces and lazy payload loading; this phase extends them so later
routing, lease, cache, and outbound-fencing work can be measured without adding
customer-facing latency.

#### Detailed step-by-step plan & procedure

1. Extend `apps/core/src/runtime/reply-trace.ts` with operational section kinds
   for the pipeline stages that are currently invisible or only log-visible:

   ```text
   webhook_ack
   message_persist
   dedupe
   notify_publish
   notify_receive
   lease_claim
   lease_heartbeat
   lease_takeover
   outbound_fence
   outbound_recovery
   cache_prewarm
   cache_use
   ```

2. Keep trace persistence best-effort and out of the reply hot path by
   extending the existing `persistReplyTrace()` behavior in
   `apps/core/src/runtime/reply-trace-persist.ts`. Do not make provider send or
   cursor advancement wait for heavy payload persistence.

3. Define a typed trace payload envelope for heavy debug payloads. It should be
   compatible with `message_traces.payloads_json` and should support stage
   lookup by stage index, because boondi-admin already uses that model.

4. Add cache trace payload slots, but leave exact `input` and `output` as
   adapter-supplied JSON. Do not fake the cache payload from partial prompt
   data. The current Anthropic `AgentRunnerLlmTurn.input` is not proven to be
   the exact full SDK request.

5. Update boondi-admin types and UI in `/Users/caw-d/Desktop/boondi-admin` to
   render the new section kinds. Keep the existing lazy `/api/trace` fetch
   behavior; do not include heavy payloads in the conversation list query.

6. Add the worker observability read model contract. It should be keyed by
   `instance_id` and include at least:

   ```text
   started_at
   last_heartbeat_at
   warm_pool.available_target
   warm_pool.generic_available
   warm_pool.generic_starting
   warm_pool.bound_active
   warm_pool.bound_idle
   warm_pool.bound_draining
   warm_pool.max_bound_workers
   queue.active_message_runs
   queue.pending_conversation_keys
   queue.max_message_runs
   ```

   For local dev, this produces one instance row. For AWS, each server writes
   its own heartbeat row, so the admin dashboard can group worker counts by
   machine without needing load-balancer stickiness or direct fan-out calls to
   app servers.

   The write path must be rate-limited to a per-instance heartbeat. Do not write
   one row per worker transition. Dashboard snapshots are observability only and
   must not drive scheduling or ownership decisions.

7. Add a boondi-admin dashboard panel for worker inventory:
   - grouped by `instance_id`;
   - visibly marks stale/unhealthy instances;
   - shows aggregate totals across all healthy instances;
   - works with a single local instance without special casing the UI.

8. Add tests:
   - core unit tests for assembling new section kinds;
   - admin UI/e2e tests proving payloads are still fetched only on expansion;
   - regression test that trace persistence failure does not fail the reply.
   - dashboard test for one local worker snapshot;
   - dashboard test for multiple instance snapshots with one stale instance.
   - dashboard test that stale instance rows are hidden or marked unhealthy.

#### Acceptance criteria (plain English)

- The dashboard can display the new pipeline stage names even before later
  phases populate all of them.
- Heavy payloads are not returned in normal conversation queries.
- Payload fetch still happens only when an operator expands a stage.
- A trace persistence failure cannot block or fail a customer reply.
- The dashboard can show warm-worker and active-worker counts for one local
  instance and is shaped to show multiple AWS instances later.

### Phase 2 - Provider default route resolver

Checkpoint:

```text
Status: Completed
Checkpoint owner: Codex
Started: 2026-06-16T23:40:03Z
Completed: 2026-06-16T23:40:37Z
Evidence:
  - `apps/core/src/app/bootstrap/channel-persistence-handlers.ts` now calls
    `projectConversationRoute()` for `providers.interakt.default_agent` and
    keeps `registerGroup()` only for explicit template cloning.
  - `apps/core/src/app/bootstrap/startup.ts` and
    `apps/core/src/config/settings/runtime-settings-types.ts` comments now
    describe `default_agent` as live virtual route projection, not persisted
    route synthesis.
  - `apps/core/test/unit/bootstrap/channel-wiring.test.ts` asserts that a new
    Interakt `wa:*` customer routes through provider default without
    `registerGroup()`, while still projecting an in-memory route for processing.
  - Hot-path impact: removes one Postgres route write from the default-agent
    first-message path; current Phase 5 work now routes configured wakeup through
    a sanitized Postgres doorbell plus owner-claim dispatcher instead of a direct
    local queue wake.
  - Tests run:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts --testNamePattern "default_agent"` (red, then green),
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts`,
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/startup.test.ts --testNamePattern "Interakt inbound routing validation"`.
Resolved by later phases:
  - Phase 5's durable reconciler now accounts for default-agent virtual routes
    by scanning durable inbound conversation ids and projecting missing live
    routes before pending-message recovery.
```

#### Summary (plain English)

Stop creating route rows for every new Boondi customer. A normal Interakt
customer should route to `providers.interakt.default_agent` virtually, while
explicit persisted routes still override the default.

#### Detailed step-by-step plan & procedure

1. Replace the per-number route materialization behavior in
   `apps/core/src/app/bootstrap/channel-persistence-handlers.ts` with an
   explicit route resolver:

   ```text
   exact persisted conversation route
   -> provider default_agent virtual route
   -> no route / reject with diagnostic
   ```

2. Preserve explicit per-conversation overrides. A stored route like
   `wa:<number> -> special_agent` must win over the provider default.

3. Keep per-customer state persistence unchanged. This phase changes routing
   config rows only, not message rows, transcripts, customer metadata, memory,
   cursors, or provider session ids.

4. Adjust startup warm-route logic in
   `apps/core/src/app/bootstrap/startup.ts`. Startup should not assume that all
   future Interakt customers have saved route rows.

5. Add tests in the current bootstrap/channel routing test area:
   - new Interakt customer uses provider default without persisting a route;
   - explicit route override still wins;
   - missing explicit route and missing provider default rejects/drops with a
     visible diagnostic;
   - existing saved routes continue to work.

#### Acceptance criteria (plain English)

- A new Interakt phone number routes to `boondi_support` through the provider
  default without creating a persisted `wa:<number>` route.
- Existing explicit routes still override the provider default.
- Conversation messages and customer state continue to persist normally.
- Warm-pool startup no longer depends on a saved route for every phone number.

### Phase 3 - Postgres conversation owner lease

Checkpoint:

```text
Status: Completed
Checkpoint owner: Codex
Started: 2026-06-17T00:22:52Z
Completed: 2026-06-17T00:26:29Z
Evidence:
  - `apps/core/src/domain/ports/conversation-owner-lease-repository.ts` defines
    the narrow provider-neutral lease port and the shared
    `conversationOwnerThreadKey()` helper.
  - `apps/core/src/adapters/storage/postgres/schema/conversation-owner-leases.ts`
    and migration `0076_conversation_owner_leases.sql` add
    `conversation_owner_leases` with non-null `thread_key`, unique
    `(app_id, conversation_id, thread_key)`, lease expiry, heartbeat, state,
    takeover/debug fields, and owner/state indexes.
  - `apps/core/src/adapters/storage/postgres/repositories/conversation-owner-lease-repository.postgres.ts`
    implements `claimLease`, `heartbeatLease`, `verifyLeaseVersion`,
    `markDraining`, `releaseLease`, and `findExpiredOrUnownedWork`.
  - `claimLease()` uses insert-or-lock-update behavior instead of expression
    upsert assumptions. Valid unexpired owners win; expired/draining rows can
    be taken over; ownership changes increment `lease_version`; same-owner
    heartbeats/refreshes do not increment it.
  - Disposable Postgres verification used a separate
    `gantry-owner-lease-test` container on port 55432 with `vector` and
    `pg_trgm` extensions enabled, not the persistent local `gantry-postgres`.
  - Red checks first:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/storage/postgres-migration-journal.test.ts --testNamePattern "conversation owner leases"`
    failed because migration `0076` was not registered;
    `npx vitest run -c vitest.integration.config.ts apps/core/test/integration/conversation-owner-lease.postgres.integration.test.ts`
    failed because the repository module did not exist.
  - DB-backed integration initially caught non-ISO Postgres timestamp strings
    escaping the adapter; the mapper now normalizes timestamp fields before
    returning lease records.
  - Green checks:
    `GANTRY_TEST_DATABASE_URL=postgres://gantry:gantry@127.0.0.1:55432/gantry_test npx vitest run -c vitest.integration.config.ts apps/core/test/integration/conversation-owner-lease.postgres.integration.test.ts`
    passed 4/4;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/storage/postgres-migration-journal.test.ts --testNamePattern "conversation owner leases"`
    passed; `npm run typecheck` passed; `git diff --check` passed.
  - Hot-path impact: no runtime hot-path work is added yet. This phase adds the
    durable ownership primitive only; later phases will decide where claims and
    fences enter processing.
Resolved by later phases:
  - Phase 4 threads ownership tokens through provider sends, streaming chunks,
    recovery sends, and side-effecting MCP calls.
  - Phase 5 integrates owner claims with conversation-work notification,
    startup recovery, and missed-notification reconciliation.
```

#### Summary (plain English)

Add the missing distributed ownership primitive. In horizontal production, any
server can receive a webhook, but only one server should process and send for a
conversation at a time.

#### Detailed step-by-step plan & procedure

1. Add the `conversation_owner_leases` schema in the Postgres adapter layer.
   Use `thread_key text not null` for uniqueness instead of relying on nullable
   `thread_id`. Include takeover/debug fields from the HLD:
   `last_claim_reason`, `last_error`, and `draining_started_at`.

2. Add a narrow repository/application port for ownership operations. Do not
   expose a monolithic storage dependency to domain/application code.

3. Implement atomic operations:

   ```text
   claimLease()
   heartbeatLease()
   verifyLeaseVersion()
   markDraining()
   releaseLease()
   findExpiredOrUnownedWork()
   ```

4. `claimLease()` should:
   - create a lease if none exists;
   - return the current valid owner if another unexpired owner exists;
   - take over only when the lease is expired or draining/takeover-eligible;
   - increment `lease_version` on every ownership change.

5. `heartbeatLease()` should update only when `owner_instance_id` and
   `lease_version` still match. Heartbeat must not increment `lease_version`.

6. `verifyLeaseVersion()` should be cheap and deterministic. It is used later
   before outbound sends.

7. Add integration tests using disposable Postgres:
   - concurrent claims for the same conversation produce one owner;
   - expired lease can be claimed by another instance;
   - stale heartbeat cannot extend a taken-over lease;
   - heartbeat does not increment `lease_version`;
   - `thread_id = null` conversations are unique through `thread_key`;
   - `markDraining()` prevents new local claims during shutdown.

#### Acceptance criteria (plain English)

- The database has a single current owner row per app/conversation/thread key.
- Lease takeover increments `lease_version`.
- Heartbeat extends the lease without changing `lease_version`.
- Stale owners cannot heartbeat a lease after takeover.
- The implementation is provider-neutral and does not mention Interakt or
  Boondi-specific agent names.

### Phase 4 - Outbound lease fencing

Checkpoint:

```text
Status: Completed
Checkpoint owner: Codex
Started: 2026-06-17T00:30:17Z
Completed: 2026-06-17T02:27:06Z
Evidence:
  - `apps/core/src/domain/types.ts` now defines a runtime-internal
    `MessageSendOwnershipToken` carried through `MessageSendOptions`.
  - `apps/core/src/app/bootstrap/channel-wiring-types.ts` adds a
    provider-neutral `verifyOutboundOwnership` hook. The hook receives the
    destination JID/thread and the opaque ownership token; channel adapters do
    not own lease verification or DB mapping.
  - `apps/core/src/app/bootstrap/channel-wiring.ts` now checks ownership tokens
    immediately before customer-visible provider dispatch for normal sends,
    recovery sends, and dry-run test sends. If a token is present and the
    verifier is missing, throws, or returns false, the provider send is blocked
    fail-closed.
  - Internal ownership tokens are stripped before `MessageSendOptions` reaches
    channel adapters.
  - Fence failures publish a provider-neutral runtime event
    `outbound.fence` and log the blocked owner/version so the failure is
    visible outside the provider send path.
  - `RuntimeApp` now exposes the same send-ownership-token resolver that normal
    group processing uses, and outbound delivery recovery asks for that token
    immediately before `channelWiring.sendProviderMessage()`. Recovered sends
    therefore pass through the same channel ownership fence as live sends.
  - `mcp_call_tool` now classifies raw third-party MCP tool names by leading
    verb plus explicit `mutationIntent` metadata. Read-shaped calls (`get`,
    `list`, `search`, `lookup`, etc.) continue normally. Write/admin/execute-
    shaped calls (`create`, `update`, `delete`, `send`, `refund`, `run`,
    `install`, etc.) must pass a current conversation ownership check before
    the MCP proxy executes; stale or missing ownership fails closed before the
    external tool call. Unknown raw MCP tool names fail closed with
    `side_effect_metadata_required` unless the call provides explicit
    `mutationIntent` metadata, and known write-shaped names cannot be
    downgraded by caller-provided read metadata.
  - The Gantry MCP `mcp_call_tool` schema now exposes required
    `mutationIntent` values (`read`, `write`, `delete`, `execute`,
    `configure`) so agents classify raw third-party MCP calls at the facade
    boundary instead of relying on a hidden IPC-only convention.
  - Side-effecting `mcp_call_tool` calls must pass both the current ownership
    fence and an external idempotency-key argument check before the proxy
    executes. The facade accepts `idempotencyKeyArgument` for tools whose raw
    key argument is not `idempotencyKey` or `idempotency_key`.
  - `StreamingChunkOptions` now carries the same runtime-internal ownership
    token. `group-processing` requests the current token before live and final
    streaming chunks, and `channel-wiring` verifies the token before provider
    streaming dispatch while stripping it from adapter-visible options.
  - Red checks first:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts --testNamePattern "owner tokens|ownership tokens"`
    failed because stale owners still sent and ownership leaked to the channel
    adapter;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/runtime-app.test.ts --testNamePattern "exposes the ownership token resolver"`
    failed because `RuntimeApp` had no runtime-services ownership resolver seam;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/runtime-services.test.ts --testNamePattern "starts outbound delivery recovery loop"`
    failed because outbound recovery sent without an ownership token;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/jobs/mcp-trace-capture.test.ts --testNamePattern "write-shaped MCP"`
    failed because a write-shaped MCP call still reached the proxy without an
    ownership check;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts --testNamePattern "ownership token.*streaming|stale owner tokens before streaming|strips ownership tokens before streaming"`
    failed because streaming chunks did not request ownership, stale ownership
    still streamed, and internal ownership leaked to adapter options.
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/jobs/mcp-trace-capture.test.ts --testNamePattern "unknown MCP tool names"`
    failed because unknown raw MCP tool names still executed without metadata
    and explicit write metadata did not trigger the ownership fence.
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/jobs/mcp-trace-capture.test.ts --testNamePattern "idempotency key"`
    failed because a current-owner write still reached the MCP proxy without an
    idempotency-key argument.
  - Green checks:
    the same focused command passed; full
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts`
    passed 64/64;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/runtime-app.test.ts --testNamePattern "exposes the ownership token resolver"`
    passed;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/runtime-services.test.ts`
    passed 22/22;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/jobs/mcp-trace-capture.test.ts --testNamePattern "unknown MCP tool names"`
    passed 3/3;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/jobs/mcp-trace-capture.test.ts --testNamePattern "idempotency key"`
    passed 2/2;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/jobs/mcp-trace-capture.test.ts`
    passed 10/10;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts`
    passed 187/187; `npm run typecheck` passed; `git diff --check` passed.
  - Hot-path impact: no extra work is added for existing sends without an
    ownership token. Once Phase 5 supplies tokens, each customer-visible send
    will pay one verifier call before provider dispatch.
Residual review items:
  - Runtime verifies idempotency-key presence, not external semantics.
    Production capability review must confirm each side-effecting MCP tool
    actually uses the named key to dedupe external mutation.
```

#### Summary (plain English)

Before enabling horizontal wakeups, prevent double-send. Every processing run
must prove it still owns the conversation immediately before sending a
customer-visible provider message.

#### Detailed step-by-step plan & procedure

1. Thread the claimed ownership token through the message processing context:

   ```text
   app_id
   conversation_id
   thread_id
   owner_instance_id
   lease_version
   ```

2. Add a fence check just before provider dispatch in the live outbound path
   around `apps/core/src/app/bootstrap/channel-wiring.ts` and
   `sendProviderMessageInternal`.

3. If the fence check fails:
   - do not call the provider send API;
   - do not settle durable delivery as sent;
   - leave enough state for the current owner/reconciler to retry safely;
   - record an `outbound_fence` trace/audit event.

4. Keep the existing durable outbound delivery behavior. This phase adds a
   current-owner gate before provider send; it does not replace durable
   idempotency keys, claims, receipts, or recovery.

5. Apply the same ownership rule to outbound recovery. A recovery send must
   verify current ownership or explicitly rebind the recovery attempt under the
   current owner before dispatch.

6. Classify side-effecting tools before production:
   - read-only tools can run under normal run ownership;
   - idempotent write tools require a current lease check and external
     idempotency key;
   - non-idempotent write tools are blocked until an idempotency strategy and
     current lease fence exist.

7. Add tests:
   - valid owner sends successfully;
   - stale owner is blocked before provider send;
   - takeover while a previous run is still alive cannot produce two provider
     sends;
   - outbound recovery cannot send from a stale owner;
   - side-effecting tool calls fail closed when ownership is stale;
   - dry-run outbound still goes through the same fence in local Boondi tests.

#### Acceptance criteria (plain English)

- A stale owner cannot send after another server has claimed the conversation.
- Existing durable outbound idempotency still works.
- Fence failures are visible in latency/trace diagnostics.
- Outbound recovery and side-effecting tools cannot bypass current ownership.

### Phase 5 - Event-driven conversation wakeup and recovery

Checkpoint:

```text
Status: Completed
Checkpoint owner: Codex
Started: 2026-06-17
Completed: 2026-06-17T02:27:06Z
Evidence:
  - Added `RuntimeMessageStoreResult`/`RuntimeMessageStoreStatus` to the narrow
    runtime message repository port.
  - `PostgresCanonicalMessageRepository.saveMessage()` now returns
    `inserted_new_message`, `duplicate_existing_message`, or
    `updated_existing_projection` and preserves the original provider message id
    in the read model for redelivered messages.
  - `channel-persistence-handlers.ts` skips prewarm and local queue wake when
    inbound persistence reports `duplicate_existing_message`.
  - Added channel unit coverage for duplicate wake suppression and Postgres
    canonical ops integration coverage for redelivery status/read-model behavior.
  - Added dedicated `gantry_conversation_work` Postgres notification publisher
    and parser, separate from the generic runtime-event notifier.
  - Channel persistence now publishes a sanitized conversation-work doorbell
    after a new inbound message is persisted and does not directly wake the
    local queue when the doorbell publisher is configured; duplicate provider
    redeliveries do not publish the normal doorbell.
  - `PostgresConversationWorkNotifier` now owns a dedicated LISTEN client for
    `gantry_conversation_work`, filters invalid/unrelated payloads, reconnects
    after listener failure, and closes on runtime storage shutdown.
  - Added `startConversationWorkDispatcher()` and startup wiring so received
    doorbells first skip clearly live other-owner hints, then claim/refresh the
    Postgres conversation owner lease before admitting local `GroupQueue` work.
    Claim loss is fail-closed and does not enqueue.
  - Added `startConversationWorkReconciler()` and startup/shutdown wiring for a
    stoppable periodic scan over expired/draining lease candidates. Recovered
    candidates must claim the Postgres conversation owner lease before local
    queue admission; claim loss is fail-closed.
  - Added `findPendingMessageWorkCandidates()` and runtime wiring so the periodic
    reconciler also scans configured routes for persisted messages after each
    conversation/thread cursor. It emits sanitized `missed_notification`
    candidates containing only app/conversation/thread identifiers.
  - `findPendingMessageWorkCandidates()` now also asks the runtime message
    repository for durable inbound conversation ids, projects a missing
    providers.interakt.default_agent virtual route through the same bootstrap
    helper used by live inbound persistence, and then scans the recovered
    route's thread cursors. This closes the restart gap for default-agent
    virtual routes without persisting per-customer route rows.
  - `PostgresCanonicalMessageRepository`,
    `CanonicalMessageOpsService`, and `PostgresRuntimeRepositoryBundle` now
    expose `listInboundConversationJids({ limit })`; the query returns distinct
    canonical inbound conversations newest-first and ignores outbound-only
    conversations.
  - Added an optional startup recovery claim gate to `recoverPendingMessages()`
    and wired it through `startRuntimeServices()` to
    `conversationOwnerLeases.claimLease()`, so startup recovery must acquire the
    same distributed owner lease before local queue admission.
  - Added an owner-claiming conversation-work publisher. Runtime publication
    now claims or observes the current owner lease before sending the doorbell
    and includes `ownerInstanceId`, `leaseVersion`, and `leaseExpiresAt` hints
    in the notification payload. If the claim path fails, it does not publish an
    unowned doorbell and leaves recovery to the reconciler.
  - Added `getMessageSendOwnershipToken` to the group-processing dependency seam
    and runtime app wiring. The runtime resolver refreshes/claims the current
    owner lease immediately before customer-visible message sends and attaches
    the returned lease version as `MessageSendOptions.ownership`; claim loss
    throws before provider dispatch.
  - `group-guardrail` and progress/finalization helpers now accept async message
    option builders so direct guardrail replies and fallback messages can use the
    same ownership-token path.
  - Red checks first:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-reconciler.test.ts`
    failed because the reconciler module did not exist;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/shutdown.test.ts`
    failed because shutdown did not close the reconciler before storage;
    the pending-message candidate test failed because
    `findPendingMessageWorkCandidates` was not exported;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/message-loop.test.ts --testNamePattern "claims recovered work"`
    failed because startup recovery did not call the owner-claim gate;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/group-processing.test.ts --testNamePattern "attaches the current ownership token"`
    failed because group processing did not request or attach ownership tokens;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/runtime-app.test.ts --testNamePattern "ownership token resolver"`
    failed because runtime app did not wire the resolver into group processing;
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-reconciler.test.ts --testNamePattern "default-agent conversations"`
    failed because the pending-message scan did not read durable inbound
    conversations or project missing routes;
    `GANTRY_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55434/gantry_test' npx vitest run -c vitest.integration.config.ts apps/core/test/integration/canonical-ops-message-store.postgres.integration.test.ts --testNamePattern "lists distinct inbound"`
    failed because the Postgres runtime ops bundle did not expose
    `listInboundConversationJids`.
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-notification-publisher.test.ts`
    failed because the owner-claiming publisher module did not exist.
  - Verification run: `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts`
  - Verification run: `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/adapters/storage/postgres/conversation-work-notifier.postgres.test.ts`
  - Verification run: `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-dispatcher.test.ts`
  - Verification run: `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/runtime/group-guardrail-trace.test.ts apps/core/test/unit/runtime/group-guardrail-inline.test.ts apps/core/test/unit/bootstrap/runtime-app.test.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts apps/core/test/unit/runtime/message-loop.test.ts apps/core/test/unit/runtime/conversation-work-reconciler.test.ts apps/core/test/unit/runtime/conversation-work-dispatcher.test.ts apps/core/test/unit/bootstrap/shutdown.test.ts`
  - Verification run: `GANTRY_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55433/gantry_test' npx vitest run -c vitest.integration.config.ts apps/core/test/integration/canonical-ops-message-store.postgres.integration.test.ts`
  - Verification run: `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts --testNamePattern "default_agent|template route|drops inbound Interakt"`
  - Verification run: `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-reconciler.test.ts`
  - Verification run: `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-notification-publisher.test.ts`
  - Verification run: `GANTRY_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55434/gantry_test' npx vitest run -c vitest.integration.config.ts apps/core/test/integration/canonical-ops-message-store.postgres.integration.test.ts`
  - Verification run: `npm run typecheck`
  - Verification run: `git diff --check`
Residual hardening items:
  - Promote conversation-work doorbells to a transactional outbox if stronger
    missed-notify latency guarantees are required; current runtime publication
    claims ownership before `pg_notify` and relies on the reconciler when the
    notification is lost.
  - Production capability review must confirm each side-effecting MCP tool
    actually uses the named idempotency-key argument to dedupe external
    mutation.
```

#### Summary (plain English)

Move the cross-server wakeup path to Postgres events without making events the
source of truth. A persisted message publishes a doorbell. Instances receive it,
claim or verify ownership, and only the owner enqueues local processing.

#### Detailed step-by-step plan & procedure

1. Add a dedicated Postgres notification channel for conversation work, separate
   from the existing generic runtime event notifier in
   `apps/core/src/adapters/storage/postgres/runtime-event-notifier.postgres.ts`.

2. Publish the notification only after the inbound message, dedupe result, route
   validity, and owner hint are committed. Preferred implementation is
   `pg_notify` inside the same transaction so delivery occurs after commit. If
   that cannot be done cleanly, use a transactional outbox and a separate
   publisher.

3. Do not publish a normal processing wakeup for duplicate provider redeliveries
   unless a diagnostic or recovery case explicitly requires it.

4. To avoid unnecessary wakeups, adjust the message persistence contract so the
   caller can distinguish:

   ```text
   inserted_new_message
   duplicate_existing_message
   updated_existing_projection
   ```

   The exact return type should be introduced through a narrow repository port
   and tests, not inferred from logs.

5. Notification payload:

   ```json
   {
     "app_id": "default",
     "conversation_id": "wa:...",
     "thread_id": null,
     "message_id": "...",
     "owner_instance_id": "server-b",
     "lease_version": 42,
     "lease_expires_at": "..."
   }
   ```

6. All instances may receive the notification. Each instance first performs the
   cheap local check:
   - if payload owner is another instance and expiry is clearly in the future,
     ignore locally;
   - otherwise verify or claim in Postgres.

7. Only the owner enqueues `GroupQueue`. `GroupQueue` remains in-process and
   reads actual messages from Postgres by cursor.

8. Use a dedicated non-transaction-pooled listener connection per Gantry
   instance. The listener must reconnect and resubscribe after connection loss.
   The AWS deployment plan must explicitly avoid PgBouncer transaction pooling
   for this listener connection.

9. Add a slow reconciler:
   - scans for persisted unprocessed messages;
   - detects missing/expired owner leases;
   - claims ownership;
   - enqueues local processing;
   - emits diagnostics for missed notification recovery.

10. Add tests:

- notification wakes the owner quickly;
- non-owner ignores locally when payload proves another valid owner;
- missed notification is recovered by reconciler;
- listener reconnects and resubscribes;
- notification payload never contains full message or prompt payload;
- duplicate webhook does not create duplicate processing;
- two customers can be owned by different instances without per-customer
  persisted route rows.

#### Acceptance criteria (plain English)

- Processing is event-driven for the common path.
- Lost notifications do not lose messages.
- Duplicate Interakt webhooks do not produce duplicate replies.
- `GroupQueue` remains local and does not pretend to be a durable queue.
- Listener pooling/reconnect constraints are documented and tested.

### Phase 6 - Sticky bound worker pool

Checkpoint:

```text
Status: Completed
Checkpoint owner: Codex
Started: 2026-06-17T01:11:40Z
Completed: 2026-06-17T02:27:06Z
Evidence:
  - `apps/core/src/runtime/warm-pool-manager.ts` now tracks acquired workers
    separately from generic idle workers and exposes a local inventory snapshot
    for generic/active counts.
  - Acquiring a generic worker now starts generic-pool replenishment immediately
    instead of waiting for the bound worker to release.
  - `apps/core/src/runtime/group-processing.ts` now attempts to pipe
    Postgres-loaded pending messages into an idle live run before spawning a new
    agent process.
  - `apps/core/src/runtime/group-queue.ts` now retains idle pooled warm workers
    after message-run teardown and releases them when the underlying runner
    process closes.
  - A DB-backed drain run that pipes a continuation into a retained pooled
    runner now hands active accounting to that live continuation and does not
    release the worker until the runner reaches idle or closes.
  - `runtime.warm_pool.max_bound_workers` is now settings-owned with parser,
    renderer, public config, and bootstrap wiring. The manager enforces the cap
    before consuming a generic worker, so inbound work remains persisted and
    schedulable instead of silently over-binding.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/warm-pool-manager.test.ts`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/group-processing.test.ts --testNamePattern "pipes persisted messages"`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/group-queue.test.ts`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/runtime/warm-pool-manager.test.ts`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/runtime/warm-pool-manager.test.ts apps/core/test/unit/runtime/conversation-work-dispatcher.test.ts`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/public-runtime-settings.test.ts --testNamePattern "warm pool"`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/public-runtime-settings.test.ts apps/core/test/unit/runtime/warm-pool-manager.test.ts apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/runtime/group-queue.test.ts apps/core/test/unit/runtime/conversation-work-dispatcher.test.ts`
  - Verification:
    `npm run typecheck`
Residual verification items:
  - Local three-warm-worker concurrency remains part of the Phase 8 full E2E
    gate, not a missing Phase 6 unit/runtime implementation item.
```

#### Summary (plain English)

Change the warm-pool meaning from "process path is warm" to "new conversations
can immediately receive a generic warm worker, and follow-ups can reuse a
conversation-bound worker until idle timeout."

#### Detailed step-by-step plan & procedure

1. Split worker states in the warm-pool implementation:

   ```text
   generic_available
   binding
   bound_active
   bound_idle
   draining
   destroyed
   ```

2. Maintain `runtime.warm_pool.size` generic workers per instance today. Later
   rename or extend this to `runtime.warm_pool.available_size` only with a
   parser/renderer migration.
   When a generic worker is bound to a conversation, immediately start
   replenishing the generic pool.

3. Add a cap for bound workers, for example
   `runtime.warm_pool.max_bound_workers`. Rejecting or queuing beyond the cap
   should be explicit and observable.

   Initial production behavior should be queue, not reject:
   - ACK and persist inbound webhooks normally;
   - do not create a new bound worker past the cap;
   - keep the conversation pending in local/durable scheduling until capacity is
     available or ownership is taken over;
   - expose overload in latency sections and worker inventory metrics.

4. Use the existing idle-timeout concept as the bound worker idle TTL unless
   the audit proves the existing setting has incompatible semantics. Do not add
   a duplicate timeout knob without proving it is needed.

5. Bind workers by the same key as ownership:

   ```text
   app_id + conversation_id + thread_key + lease_version
   ```

   If the lease is taken over, the old bound worker is no longer allowed to
   send because outbound fencing will fail.

6. Prove and adjust the terminal-output lifecycle. The current pooled path may
   resolve on terminal output and release the worker after a reply. The new
   sticky path must keep the runner alive until idle timeout when the SDK runner
   supports continuation.

7. On worker crash while the server remains owner:
   - destroy the local worker handle;
   - keep or refresh the owner lease if the server is healthy;
   - acquire a replacement generic worker;
   - rebuild context from durable state and provider session id.

8. Add tests:
   - first message binds a generic worker;
   - generic pool replenishes after binding;
   - follow-up within idle timeout uses the same bound worker;
   - bound worker is destroyed after idle timeout;
   - bound worker is never reused for another conversation;
   - bound worker cap is enforced;
   - bound worker cap queues work instead of dropping persisted inbound
     messages;
   - worker crash rebuilds from durable state.
   - local concurrency test with `runtime.warm_pool.available_size = 3` and
     three concurrent customer conversations.

9. Use the three-warm-worker local test as the first hypothesis check:

   ```text
   configured generic warm pool = 3
   three new customers arrive concurrently
   -> each gets a warm generic worker
   -> generic pool replenishment starts
   -> no per-customer startup spike beyond expected bind/run overhead
   -> dashboard shows generic/bound counts changing as expected
   ```

   This test should assert behavior from runtime state and traces, not only by
   visual inspection.

#### Acceptance criteria (plain English)

- The server maintains the configured number of generic available workers.
- A follow-up from the same conversation within idle timeout reuses the bound
  worker when the lease still belongs to this instance.
- Worker death does not lose conversation continuity.
- Bound worker lifecycle is observable in latency/diagnostics.
- Bound worker cap overload is visible and does not drop inbound messages.
- With `available_size = 3`, three concurrent local conversations exercise
  three warm workers and validate the expected generic-to-bound transition.

### Phase 7 - Prompt-cache prewarm and exact cache visibility

Checkpoint:

```text
Status: Completed
Checkpoint owner: Codex
Started: 2026-06-17T01:33:50Z
Completed: 2026-06-17T21:32:00+05:30
Evidence:
  - Warm worker handles now carry provider-neutral cache prewarm status:
    `succeeded`, `skipped`, or `failed`.
  - `WarmPoolManager` now calls the optional `prewarmCaches` capability before
    marking a generic worker idle. Cache-prewarm failures are recorded on the
    handle and do not discard the worker.
  - Cache prewarm probes are concurrency-bounded separately from process boot
    prewarm so provider cache probes cannot fan out unchecked.
  - The Anthropic adapter now returns explicit skipped/succeeded status for
    cache prewarm instead of a silent no-op.
  - Warm worker handles now expose a provider-neutral cache shape key for the
    active Anthropic SDK path. The shape separates execution provider,
    credential profile, app, agent, model, prompt hash, tool surface, and MCP
    set while excluding resume/session handles.
  - The active Anthropic SDK path now records cache prewarm as succeeded for
    handles created by `prewarm()`, because generic boot waits for the SDK
    `startup()` call to complete before the worker reports bind-ready. Ad hoc
    handles without that adapter marker still report an explicit skipped reason.
  - When `GANTRY_TRACE_PAYLOADS=1`, warm generic Anthropic runners now emit a
    customer-free `cache_prewarm` payload from the actual SDK
    `startup({ options })` boundary. The captured payload remains gated by the
    existing lazy Control API read, audit event, redaction, size limit, and
    retention policy, but it is no longer inserted into customer reply latency
    sections.
  - `GET /v1/runtime/workers` now exposes aggregate cache shape/status
    visibility from the warm-pool inventory so operators can see prewarm status
    without exact payload capture.
  - Customer reply latency traces no longer include `cache_prewarm` as a reply
    section and no longer move the reply `windowStart` backward to the
    prewarm timestamp. Cache prewarm is operational warmup work, not
    customer-visible first-reply latency.
  - For Interakt default-agent conversations, inbound persistence now runs the
    route prewarm hook before publishing the event-pipe work notification. The
    first reply path should see a prewarmed route shape when prewarm is enabled,
    instead of admitting queue work before the route-specific warmup has run.
  - boondi-admin now renders cache prewarm/use sections in the latency report,
    lazy-loads cache payload envelopes only on expansion, and adds a Runtime tab
    for the worker inventory endpoint.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/warm-pool-manager.test.ts --testNamePattern "cache prewarm"`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/adapters/anthropic-warm-pool.test.ts`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/application/warm-pool-capable.test.ts apps/core/test/unit/adapters/anthropic-warm-pool.test.ts apps/core/test/unit/runtime/warm-pool-manager.test.ts`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/adapters/anthropic-warm-pool.test.ts --testNamePattern "SDK startup cache prewarm"`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runner/agent-runner-ipc.test.ts apps/core/test/unit/adapters/anthropic-warm-pool.test.ts apps/core/test/unit/runtime/group-processing.test.ts --testNamePattern "SDK startup cache prewarm|exact SDK startup cache prewarm|persists cache prewarm payloads"`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/application/warm-pool-capable.test.ts apps/core/test/unit/adapters/anthropic-warm-pool.test.ts apps/core/test/unit/runtime/warm-pool-manager.test.ts apps/core/test/unit/runtime/worker-inventory-snapshot.test.ts apps/core/test/unit/bootstrap/runtime-app.test.ts apps/core/test/unit/control/system-routes.test.ts apps/core/test/unit/control/openapi.test.ts`
  - Verification:
    `npx tsc --noEmit --pretty false`
  - Exact trace payload reads now go through Gantry Control API:
    `GET /v1/messages/{messageId}/trace-payloads` requires
    `messages:admin`, returns the same lazy `{ payloads }` shape for admin UI,
    and emits a `trace.payload_read` runtime event with the message id and
    payload availability.
  - `PostgresMessageTraceRepository` now applies payload policy before storing
    exact traces: high-risk secret fields and bearer/provider token-looking
    values are redacted, and oversized payload bundles are replaced with a
    bounded `__gantryPayloadPolicy` truncation marker.
  - `PostgresMessageTraceRepository.clearPayloadsOlderThan()` can remove old
    `payloads_json` blobs while preserving timing rows for retention cleanup.
  - Runtime startup now runs a settings-owned exact-payload retention loop using
    `runtime.trace.payload_retention_ms` and
    `runtime.trace.payload_cleanup_interval_ms`; shutdown closes the loop before
    queue drain.
  - boondi-admin `/api/trace` now proxies exact payload expansion through the
    Gantry Control API instead of selecting `payloads_json` directly from
    Postgres. The browser-facing API shape remains unchanged and the Control
    API bearer token stays server-side.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/message-trace-repository.test.ts apps/core/test/unit/control/message-trace-routes.test.ts apps/core/test/unit/control/openapi.test.ts`
  - Verification:
    `cd /Users/caw-d/Desktop/boondi-admin && npm run build`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/public-runtime-settings.test.ts apps/core/test/unit/runtime/message-trace-payload-retention.test.ts apps/core/test/unit/bootstrap/shutdown.test.ts --testNamePattern "trace payload retention|startMessageTracePayloadRetention|shutdown order"`
  - Fresh Phase 7 focused verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/application/warm-pool-capable.test.ts apps/core/test/unit/adapters/anthropic-warm-pool.test.ts apps/core/test/unit/runtime/warm-pool-manager.test.ts apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/runtime/reply-trace-persist.test.ts apps/core/test/unit/runtime/message-trace-repository.test.ts apps/core/test/unit/control/message-trace-routes.test.ts apps/core/test/unit/control/openapi.test.ts --testNamePattern "cache prewarm|prewarmCaches|cache-ready|payload|trace payload|excludes cache prewarm|Payload"`
    passed 6 files / 16 selected tests, with 2 files and unrelated tests
    skipped by the name filter.
  - Fresh boondi-admin verification:
    `cd /Users/caw-d/Desktop/boondi-admin && npm run build` passed.
  - Fresh boondi-admin e2e verification:
    `cd /Users/caw-d/Desktop/boondi-admin && PORT=3127 npm run test:e2e -- e2e/latency-report.spec.ts e2e/runtime-workers.spec.ts --reporter=list`
    passed 4/4 tests. The first plain `npm run test:e2e -- ...` attempt timed
    out waiting for `localhost:3000` because an existing Next server on that
    port returned HTTP 500; the isolated port run avoided the stale listener
    and exercised the same latency/runtime UI specs.
Open follow-ups:
  - TODO(deferred): non-Anthropic SDK/provider cache-prewarm and warm-worker
    behavior is out of scope for the current implementation. Keep the runtime
    contracts provider-neutral, but only the Anthropic SDK path is active until
    another provider adapter is explicitly prioritized.
  - Settings-owned cache-prewarm enablement replaced
    `GANTRY_WARM_POOL_CACHE_PROBE` in Phase 8 cleanup.
```

#### Summary (plain English)

Make "warm" include prompt-cache readiness, not just process readiness. The
first real customer should not pay the cache-write cost when a generic worker
was already prepared for the same agent/model/tool/prompt shape.

#### Detailed step-by-step plan & procedure

1. Define the cache shape key from provider-neutral runtime inputs:

   ```text
   provider family
   execution provider id / credential profile
   agent id
   model alias
   prompt version/hash
   tool/MCP surface hash
   selected capabilities/skills hash
   ```

2. Implement Anthropic cache prewarm in the Anthropic adapter boundary, not in
   Boondi-specific code. The probe must be customer-free and must not include a
   phone number, transcript, CRM result, or customer memory.

3. A generic worker is considered cache-ready only after:
   - process/SDK initialization succeeds;
   - tool/MCP projection is ready;
   - cache prewarm completes or explicitly records a skipped/failed reason.

4. Respect credential capacity. Cache prewarm probes spend provider quota and
   can worsen latency if they compete with live turns. Add a concurrency limit
   for prewarm probes and make it lower priority than live customer turns.

5. Capture exact cache input/output at the adapter/prewarm boundary when trace
   payload capture is enabled. Persist the payload asynchronously through the
   trace payload path from Phase 1.

   Production controls are mandatory:
   - exact payload capture disabled by default;
   - admin-only access;
   - audit event when exact payload is viewed;
   - payload byte limit;
   - retention window;
   - redaction of provider credentials, signing secrets, bearer tokens, and MCP
     secret values;
   - explicit policy for customer PII in captured prompts.

6. Show cache observability in admin:
   - cache shape key;
   - cache read/write token counts;
   - prewarm status;
   - exact captured cache input/output when enabled;
   - skipped/failed prewarm reason.

7. Add tests:
   - cache probe is not called unless enabled/configured;
   - cache prewarm happens before a worker is marked cache-ready;
   - live turn can proceed if prewarm is disabled or failed by policy;
   - payload capture does not block live reply;
   - payload redaction excludes secrets;
   - exact payload reads are audited;
   - retention cleanup removes old payloads.

#### Acceptance criteria (plain English)

- A cache-ready worker has performed a customer-free cache prewarm or records
  why it did not.
- The admin panel can show exact cache input/output when tracing is enabled.
- Cache payload capture does not add customer-facing latency.
- Prewarm cannot starve live customer traffic under the same provider
  credential.
- Exact cache payload visibility is access-controlled, audited, size-limited,
  and retention-limited.

### Phase 8 - Configuration, shutdown, chaos tests, and E2E

Checkpoint:

```text
Status: Completed
Checkpoint owner: Codex
Started: 2026-06-17T01:39:20Z
Completed: 2026-06-17T19:09:10Z
Evidence:
  - Warm-pool enablement is now settings-owned. `GANTRY_WARM_POOL=1` no longer
    force-enables runtime warm pool.
  - Cache prewarm policy is now settings-owned via
    `runtime.warm_pool.cache_prewarm_enabled` and
    `runtime.warm_pool.cache_prewarm_concurrency`.
  - Startup `.env` hydration no longer imports `GANTRY_WARM_POOL`.
  - Cleanup search found no active source/test use of
    `GANTRY_WARM_POOL_CACHE_PROBE`; the only `GANTRY_WARM_POOL` active test
    reference verifies the legacy env is ignored.
  - Live runner retention is now settings-owned as
    `runtime.runner.idle_timeout_ms`; legacy `IDLE_TIMEOUT` is ignored by
    runtime config.
  - `scripts/boondi-test-setup.sh` no longer exports `IDLE_TIMEOUT`; it warns
    when the configured `runtime.runner.idle_timeout_ms` does not match the
    requested `BOONDI_TEST_IDLE_TIMEOUT_MS` window.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/public-runtime-settings.test.ts apps/core/test/unit/adapters/anthropic-warm-pool.test.ts --testNamePattern "warm pool|prewarmCaches"`
  - Verification:
    `npx vitest run apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/public-runtime-settings.test.ts apps/core/test/unit/repo/boondi-scenarios.test.ts apps/core/test/unit/runtime/agent-spawn-process.test.ts apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/runtime/agent-spawn.test.ts apps/core/test/integration/runtime-host-child-process.integration.test.ts`
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/ipc-auth-secret-source.test.ts`
  - Verification:
    `npm run build`
  - Verification:
    `npm run test:unit`
  - Verification:
    `npm run typecheck`
  - Verification:
    `git diff --check`
  - Verification:
    `GANTRY_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55439/gantry_test' npx vitest run -c vitest.integration.config.ts apps/core/test/integration/conversation-owner-lease.postgres.integration.test.ts apps/core/test/integration/canonical-ops-message-store.postgres.integration.test.ts`
  - Disposable Postgres `8ad65a931f2456225b36fddc989aa28367cf1fd465f58d7668429d6cbaf36c76`
    was removed after integration verification.
  - Dev-mode startup from this checkout with `/Users/caw-d/gantry/.env`
    loaded reached database initialization, settings reconciliation, channel
    initialization, and "Gantry running", but then failed because local
    `GANTRY_CONTROL_API_KEYS_JSON` was not valid JSON.
  - Dev-mode startup from this checkout succeeded with only
    `GANTRY_CONTROL_API_KEYS_JSON` unset for the verification process:
    `Control server listening on TCP` at `127.0.0.1:4710`; HTTP probe returned
    `404`, confirming the listener was alive. The verification process was
    stopped cleanly with SIGINT.
  - Latest verification after the Phase 4/5 hardening follow-ups:
    `npm run build` passed;
    `npm run test:unit` passed 359 files / 3699 tests;
    `npm run typecheck` passed;
    `git diff --check` passed.
  - Latest dev-mode smoke first reached `Gantry running` but failed with
    `EADDRINUSE 127.0.0.1:4710` because an older node process from this same
    worktree was still listening. After stopping that specific PID, dev-mode
    startup with `GANTRY_CONTROL_API_KEYS_JSON` unset reached `Gantry running`,
    control TCP listened on `127.0.0.1:4710`, root HTTP probe returned `404`,
    SIGINT shut down cleanly, and port 4710 was free afterward.
  - External runtime env cleanup:
    `/Users/caw-d/gantry/.env` was backed up to
    `/Users/caw-d/gantry/.env.codex-backup-20260617T023523Z`; the malformed
    `GANTRY_CONTROL_API_KEYS_JSON` line was disabled with a comment, and the
    stale `GANTRY_WARM_POOL` entry was removed. Follow-up key scan showed no
    active `GANTRY_WARM_POOL`, `GANTRY_WARM_POOL_CACHE_PROBE`, or
    `IDLE_TIMEOUT` entries in `/Users/caw-d/gantry/.env` or
    `/Users/caw-d/gantry/settings.yaml`.
  - Normal dev-mode startup from this checkout now succeeds without unsetting
    any env var: `npm run dev` reached `Gantry running`, control TCP listened
    on `127.0.0.1:4710`, root HTTP probe returned `404`, SIGINT shut down
    cleanly, and port 4710 was free afterward.
  - Local Control API bearer auth is configured again in
    `/Users/caw-d/gantry/.env` with a generated local-dev owner key. The
    previous env file was backed up to
    `/Users/caw-d/gantry/.env.codex-backup-20260617T111915Z`. Normal
    `npm run dev` from this checkout reached `Gantry running`, listened on
    `127.0.0.1:4710`, and an authenticated `GET /v1/runtime/workers` probe
    returned HTTP 200 with one healthy instance. SIGINT shut down cleanly, port
    4710 was free afterward, and the startup log had no
    `GANTRY_CONTROL_API_KEYS_JSON must be valid JSON` error.
  - `scripts/boondi-test-setup.sh` now starts core and boondi-crm with
    `nohup ... < /dev/null & disown`, so a normal terminal launch does not tie
    the test services to the setup script's shell. In the Codex command
    harness, a held-open shell session is still required because the harness
    cleans descendant processes after a command returns.
  - Live Boondi setup from the current checkout reached READY with core
    listening on `127.0.0.1:4710` and boondi-crm listening on
    `127.0.0.1:8082`.
  - Live Boondi `conversation` regression exposed two runtime plumbing defects
    that are now fixed:
    `conversation_owner_leases` stores canonical conversation/thread foreign
    keys while repository callers keep runtime JIDs, and production
    `createChannelWiring()` now has a real outbound ownership verifier.
  - Streamed runtime-event persistence is now fail-soft like model-usage
    telemetry, so a transient `runtime_events.run_id` FK miss cannot abort a
    customer reply.
  - Focused verification passed:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/outbound-ownership-verifier.test.ts apps/core/test/unit/runtime/conversation-work-notification-publisher.test.ts apps/core/test/unit/runtime/conversation-work-dispatcher.test.ts apps/core/test/unit/runtime/conversation-work-reconciler.test.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts apps/core/test/unit/repo/boondi-scenarios.test.ts`.
  - Focused verification passed:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/group-processing.test.ts --testNamePattern "streamed runtime event persistence|Postgres-authoritative session context"`.
  - `npm run typecheck -- --pretty false` passed after the ownership and
    telemetry fixes.
  - Live Boondi `node scripts/boondi-regression.mjs conversation` on the
    current checkout finished `22 passed, 0 failed` in 292.6s after raising the
    broad live-flow correctness gate's default `TURN_TIMEOUT_MS` to 180s. The
    exact previously failing scenario also passed as a focused run with
    `BOONDI_SCENARIOS=/tmp/boondi-small-celebration.json node
    scripts/boondi-regression.mjs conversation`.
  - Runtime plumbing signatures were clean in `/tmp/gantry-dev.log`: zero
    `conversation_owner_leases` errors, zero conversation-work claim/reconcile
    errors, zero outbound ownership fence rejects, zero
    `runtime_events_run_id_fkey` errors, and zero output-callback failures.
  - Live Boondi `node scripts/boondi-isolation.mjs` first reported missing
    replies with its old 60s settle window, but flow logs showed the two
    flagged conversations replied late at about 112s and 150s. After raising
    the default `ISOLATION_SETTLE_MS` to 180s, the same isolation gate passed:
    four conversations received one reply each, with no cross-chat bleed.
  - Boondi-owned prompt/tool-payload hardening added explicit
    `customerReplyDraft`, `answerGuidance`, and `replyContract` contracts for
    Shopify and CRM-facing paths so successful tool results do not degrade into
    hiccup text or lookup narration under warm-pool/load variance.
  - Focused unit verification passed:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/application/mcp-tool-proxy.test.ts apps/core/test/unit/repo/boondi-scenarios.test.ts packages/mcp-shopify/test/unit/tools/gifting-context.test.ts packages/mcp-shopify/test/unit/tools/get-recent-orders-with-details.test.ts packages/mcp-shopify/test/unit/tools/products-inventory-discount.test.ts`
    (5 files / 53 tests).
  - CRM extractor prompt verification passed:
    `cd packages/mcp-crm && npx vitest run -c vitest.config.ts test/get-open-records.test.ts test/extractor-prompt.test.ts`
    (2 files / 4 tests).
  - Live Boondi Shopify correctness gate passed after the compact
    `get_gifting_context` payload change:
    `BOONDI_SESSION_RESET=1 GANTRY_DEV_LOG=/tmp/gantry-dev.log node scripts/boondi-regression.mjs shopify`
    finished `21 passed, 0 failed` in 317.9s.
  - Live Boondi CRM correctness gate passed after a clean offline reset of CRM
    test phones and returning-persona seed, then running with
    `BOONDI_NO_RESET=1 BOONDI_SESSION_RESET=1` to prevent the CRM watcher from
    replaying stale pre-reset digests:
    `node scripts/boondi-regression.mjs crm` finished `16 passed, 0 failed` in
    418.4s.
  - Focused CRM retry for `query-to-lead-upgrade-after-later-digest` first
    exposed stale digest replay from the CRM background watcher. With CRM
    offline, resetting `000000058`, restarting the held stack, and running the
    focused scenario with `BOONDI_NO_RESET=1` passed `1 passed, 0 failed`. This
    is a test-environment reset ordering constraint, not a runtime routing
    failure.
  - Runtime-plumbing smoke from the held local stack passed without judging
    Boondi semantic behavior. Health checks returned Shopify MCP `{"ok":true}`,
    Boondi CRM MCP `{"ok":true}`, and core HTTP `404` on `127.0.0.1:4710`.
    A signed fake Interakt webhook from `000000001` ACKed `200`, produced one
    `flow:guardrail`, one Shopify `flow:mcp.request`, one Shopify
    `flow:mcp.response`, and one dry-run `flow:outbound`. A signed fake
    Interakt webhook from seeded returning phone `000000050` ACKed `200`,
    produced one `flow:guardrail`, one Boondi CRM `flow:mcp.request`, one
    Boondi CRM `flow:mcp.response`, and one dry-run `flow:outbound`.
  - The later combined Boondi scenario gate was intentionally stopped after the
    operator narrowed the verification focus to basic inbound/outbound and MCP
    connectivity, not CRM/Shopify customer-behavior assertions.
  - `npm run smoke:boondi-runtime` now codifies the runtime-plumbing smoke as a
    repeatable local check backed by `scripts/boondi-runtime-smoke.mjs`. Fresh
    verification against the held local stack:
    `GANTRY_DEV_LOG=/tmp/gantry-dev.log npm run smoke:boondi-runtime`
    returned `ok: true`; Shopify and CRM each had one guardrail event, one MCP
    request, one MCP response, and one outbound dry-run event.
  - The runtime smoke now resends the same provider message id after each
    successful test turn and fails if the duplicate produces another guardrail,
    MCP request/response, or outbound event for that chat. This keeps the
    duplicate-webhook chaos check focused on Gantry inbound dedupe and avoids
    Boondi semantic assertions.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/repo/boondi-scenarios.test.ts --testNamePattern "basic runtime smoke"`
    first failed before the duplicate-inbound probe existed, then passed after
    adding it.
  - Fresh live verification of the updated smoke passed against
    `npm run dev:boondi-runtime` from this checkout:
    `GANTRY_DEV_LOG=/tmp/gantry-capture.log npm run smoke:boondi-runtime`
    returned `ok: true`; Shopify and CRM each had one guardrail event, one MCP
    request, one MCP response, one outbound dry-run event, and
    `duplicateInbound: true`. Ctrl-C stopped the stack and ports 4710, 8081,
    and 8082 were free afterward.
  - `npm run dev:boondi-runtime` now starts the same local plumbing stack in one
    foreground process: Gantry core, `shopify-api`, and `boondi-crm`, with
    dry-run outbound, flow logging, health checks, and Ctrl-C child cleanup.
  - Phase 8 switch ownership is now captured in
    `docs/architecture/runtime-switch-reference.md`, including each runtime
    `settings.yaml` key, remaining env-owned diagnostics/test switches,
    script-owned smoke knobs, and removed legacy switches.
  - Conversation-owner timing is now settings-owned under
    `runtime.ownership`: `lease_ttl_ms`, `reconciler_interval_ms`,
    `reconciler_limit`, and `shutdown_claim_wait_ms`. Runtime startup uses the
    settings-derived ownership config for send-time owner claims, notification
    publication, dispatcher/reconciler claims, recovered-work claims, reconciler
    cadence/limit, and bounded shutdown claim cleanup.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/architecture/runtime-switch-reference.test.ts`
    passed.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/public-runtime-settings.test.ts`
    passed.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/public-runtime-settings.test.ts apps/core/test/unit/architecture/runtime-switch-reference.test.ts`
    first failed because `runtime.ownership` was missing, then passed after
    adding the settings-owned ownership surface and switch-reference rows.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/runtime-app.test.ts apps/core/test/unit/bootstrap/shutdown.test.ts apps/core/test/unit/runtime/conversation-work-claim-gate.test.ts apps/core/test/unit/runtime/conversation-work-dispatcher.test.ts apps/core/test/unit/runtime/conversation-work-reconciler.test.ts apps/core/test/unit/runtime/conversation-work-notification-publisher.test.ts apps/core/test/unit/runtime/message-loop.test.ts`
    passed after wiring runtime ownership timing through settings.
  - Graceful shutdown now stops conversation-work notification/reconciler claim
    sources before queue drain, waits for active `GroupQueue` work while
    existing leases remain send-fence-valid, releases cleanly finished tracked
    owner leases, then marks any remaining instance
    `conversation_owner_leases` rows as `draining`. Release/drain cleanup is
    fail-soft so shutdown can still proceed if Postgres is already unavailable.
  - Runtime shutdown is now single-flight across duplicate SIGINT/SIGTERM
    delivery. Shutdown also stops IPC sockets before warm-pool worker teardown
    and closes egress gateways before storage, so local stack Ctrl-C does not
    write drain frames to already-closed runner sockets or publish egress audit
    events after the Postgres pool is ended.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/shutdown.test.ts`
    first failed because duplicate signals ran cleanup twice and IPC socket
    shutdown happened after warm-pool teardown, then passed after making
    shutdown single-flight and moving IPC shutdown earlier.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/shutdown.test.ts`
    first failed because egress gateways had no shutdown hook, then passed after
    closing egress gateways before warm-pool/storage teardown.
  - New conversation-work ownership claims now pass through a closeable runtime
    claim gate. Shutdown closes that gate before queue drain so publisher,
    dispatcher, reconciler, and pending-work recovery cannot acquire new owner
    leases while existing active queue work can still resolve send-time
    ownership tokens.
  - The notification dispatcher itself now also fails closed after `close()`;
    an already-captured or in-flight notification callback cannot acquire a new
    conversation-owner lease after shutdown starts.
  - The dispatcher also rechecks shutdown after awaited ownership claims, so a
    claim that completes after `close()` does not enqueue local work.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-dispatcher.test.ts`
    first failed because an in-flight claim enqueued after dispatcher close,
    then passed after adding the post-claim closed guard.
  - The conversation-work reconciler now also fails closed if `close()` lands
    while a storage scan is in flight; completed scans after shutdown do not
    claim leases or enqueue local `GroupQueue` work.
  - The reconciler also rechecks shutdown after awaited ownership claims, so a
    claim that completes after `close()` does not enqueue local work.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-reconciler.test.ts`
    first failed because an in-flight reconciler claim enqueued after close,
    then passed after adding the post-claim closed guard.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-reconciler.test.ts`
    first failed because the reconciler claimed after `close()` during an
    in-flight scan, then passed after adding post-scan and pre-claim closed
    checks.
  - The claim gate tracks only leases this runtime actually acquired for new
    work and releases the latest tracked lease version after active queue work
    drains. Claims lost to another owner are not released by this instance.
  - Claim-gate shutdown cleanup now attempts every tracked lease release before
    surfacing the first release failure, so one stuck lease does not prevent
    other cleanly drained leases from being released before the remaining
    instance leases are marked `draining`.
  - The claim gate now rejects late claim results if `close()` lands while the
    underlying repository claim is in flight. If the late result acquired a
    lease, the gate still tracks it for release/drain cleanup before rejecting
    it to the caller.
  - Claim-gate release cleanup now waits for claim attempts that had already
    started before shutdown before it snapshots tracked leases, so late acquired
    leases are included in clean release cleanup instead of surviving until
    drain fallback or TTL expiry.
  - That in-flight claim wait is bounded. Normal repository claims get a chance
    to finish and enter clean release cleanup, but a stuck claim cannot block
    shutdown forever; unreleased local owner rows still fall through to the
    `draining`/TTL fallback.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-claim-gate.test.ts`
    first failed because `releaseTrackedLeases()` waited indefinitely for a
    stuck in-flight claim, then passed after adding the bounded wait.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-claim-gate.test.ts`
    first failed because `releaseTrackedLeases()` settled before an in-flight
    claim completed, then passed after tracking and awaiting in-flight claim
    attempts before release cleanup.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-claim-gate.test.ts`
    first failed because a post-close in-flight claim returned an acquired
    lease, then passed after adding the post-await closed check while retaining
    the acquired lease for cleanup.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-claim-gate.test.ts`
    first failed because the second tracked release was skipped after the first
    release threw, then passed after release cleanup was hardened.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-dispatcher.test.ts`
    first failed because a retained callback claimed after `close()`, then
    passed after adding the dispatcher closed guard.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/shutdown.test.ts`
    passed.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-dispatcher.test.ts apps/core/test/unit/runtime/conversation-work-reconciler.test.ts apps/core/test/unit/bootstrap/runtime-app.test.ts`
    passed.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-claim-gate.test.ts`
    passed.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/shutdown.test.ts apps/core/test/unit/runtime/conversation-work-claim-gate.test.ts`
    passed.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-notification-publisher.test.ts apps/core/test/unit/runtime/conversation-work-dispatcher.test.ts apps/core/test/unit/runtime/conversation-work-reconciler.test.ts apps/core/test/unit/bootstrap/shutdown.test.ts`
    passed.
  - Latest verification after the bounded claim-gate wait:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/conversation-work-claim-gate.test.ts apps/core/test/unit/runtime/conversation-work-dispatcher.test.ts apps/core/test/unit/runtime/conversation-work-reconciler.test.ts apps/core/test/unit/runtime/conversation-work-notification-publisher.test.ts apps/core/test/unit/bootstrap/shutdown.test.ts`
    passed 5 files / 23 tests; `npx tsc --noEmit --pretty false` passed;
    `git diff --check` passed; ports 4710, 8081, and 8082 were free; the
    removed-switch scan found no active legacy keys in `/Users/caw-d/gantry/.env`
    or `/Users/caw-d/gantry/settings.yaml`.
  - Latest focused verification after settings-owned ownership timing and
    shutdown-order cleanup:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/public-runtime-settings.test.ts apps/core/test/unit/architecture/runtime-switch-reference.test.ts apps/core/test/unit/bootstrap/runtime-app.test.ts apps/core/test/unit/bootstrap/shutdown.test.ts apps/core/test/unit/runtime/conversation-work-claim-gate.test.ts apps/core/test/unit/runtime/conversation-work-dispatcher.test.ts apps/core/test/unit/runtime/conversation-work-reconciler.test.ts apps/core/test/unit/runtime/conversation-work-notification-publisher.test.ts apps/core/test/unit/runtime/message-loop.test.ts apps/core/test/unit/runtime/agent-spawn.test.ts`
    passed 11 files / 207 tests; `npx tsc --noEmit --pretty false` passed;
    `git diff --check` passed.
  - Fresh runtime-plumbing smoke after the shutdown cleanup passed against
    `npm run dev:boondi-runtime` from this checkout:
    `GANTRY_DEV_LOG=/tmp/gantry-capture.log npm run smoke:boondi-runtime`
    returned `ok: true`; Shopify and CRM each had one guardrail event, one MCP
    request, one MCP response, one outbound dry-run event, and
    `duplicateInbound: true`. Ctrl-C stopped the stack and ports 4710, 8081,
    and 8082 were free afterward. Log scan found no `write EPIPE`,
    duplicate-control-close, ended Postgres pool, conversation-owner,
    conversation-work, ownership-fence, runtime-event FK, output-callback,
    `EADDRINUSE`, or unhandled-error signatures.
  - The basic runtime smoke now supports `SMOKE_CONCURRENCY`, includes a third
    independent fake-phone smoke turn, and scopes completion/dedupe checks to
    parsed JSON flow records for the same chat JID. This keeps the local
    three-worker gate focused on signed inbound, guardrail entry, MCP
    request/response, outbound dry-run, and duplicate provider-message dedupe
    without asserting CRM or Shopify customer-behavior semantics.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/repo/boondi-scenarios.test.ts --testNamePattern "basic runtime smoke"`
    first failed because the smoke had no concurrency support, then failed
    again because loose substring matching could mix concurrent chat logs before
    a duplicate probe, then passed after adding bounded concurrency and
    per-chat parsed-flow matching.
  - Live verification:
    `GANTRY_DEV_LOG=/tmp/gantry-capture.log SMOKE_CONCURRENCY=3 npm run smoke:boondi-runtime`
    passed against `npm run dev:boondi-runtime` from this checkout. The result
    returned `ok: true`, `concurrency: 3`, and for `shopify`,
    `shopify-secondary`, and `crm` each reported one guardrail event, one MCP
    request, one MCP response, one outbound dry-run event, and
    `duplicateInbound: true`. Ctrl-C stopped the stack and ports 4710, 8081,
    and 8082 were free afterward.
  - The first concurrent smoke exposed a runtime-log hygiene issue: concurrent
    worker spawns can legitimately collide on an egress gateway preferred port,
    then fall back to the next stable candidate. `egress-gateway` now suppresses
    the duplicate generic `Egress gateway server error` warning for handled
    pre-listen `EADDRINUSE`/`EACCES` collisions while preserving the explicit
    fallback warning and all real server-error logging after registration.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/egress-gateway.test.ts --testNamePattern "preferred port collision"`
    first failed because the handled preferred-port collision also logged
    `Egress gateway server error`, then passed after suppressing only the
    pre-registration listen-collision log. Full
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/egress-gateway.test.ts`
    passed 8/8.
  - Fresh live verification after the egress logging fix:
    `GANTRY_DEV_LOG=/tmp/gantry-capture.log SMOKE_CONCURRENCY=3 npm run smoke:boondi-runtime`
    passed with `ok: true`, `concurrency: 3`, one guardrail/MCP
    request/MCP response/outbound event per smoke chat, and
    `duplicateInbound: true` for all three chats. Ctrl-C stopped the stack;
    ports 4710, 8081, and 8082 were free; log scan found no `Egress gateway
    server error`, `EADDRINUSE`, shutdown, conversation-owner, conversation-work,
    ownership-fence, runtime-event FK, output-callback, or unhandled-error
    signatures.
  - The runtime stack now generates a short-lived local smoke control API token
    and writes it to a 0600 `GANTRY_RUNTIME_SMOKE_ENV` sidecar. The printed
    smoke command uses that sidecar to authenticate to `GET /v1/runtime/workers`
    and verify the runtime worker inventory endpoint before sending signed
    inbound smoke webhooks.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/repo/boondi-scenarios.test.ts --testNamePattern "basic runtime smoke|basic runtime MCP stack"`
    first failed because the stack/smoke did not provide authenticated worker
    inventory coverage, then passed after adding the local token sidecar and
    `/v1/runtime/workers` probe.
  - Verification:
    `node --check scripts/boondi-runtime-smoke.mjs && node --check scripts/lib/runtime-smoke-env.mjs && bash -n scripts/boondi-runtime-stack.sh`
    passed.
  - Fresh live verification of the authenticated-smoke update:
    `GANTRY_DEV_LOG=/tmp/gantry-capture.log npm run dev:boondi-runtime`
    reached READY and printed
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env npm run smoke:boondi-runtime`.
    Then
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env SMOKE_CONCURRENCY=3 npm run smoke:boondi-runtime`
    passed with `ok: true`, `concurrency: 3`, one guardrail/MCP request/MCP
    response/outbound event per smoke chat, and `duplicateInbound: true` for
    all three chats. The smoke env sidecar was removed on stack shutdown, ports
    4710, 8081, and 8082 were free, and the log signature scan found no
    egress, shutdown, conversation-owner, conversation-work, ownership-fence,
    runtime-event FK, output-callback, or unhandled-error matches.
  - Local runtime stack child processes now strip `OPENAI_API_KEY` in addition
    to Anthropic/Claude raw credential variables, so the basic runtime/MCP
    startup path does not inherit wrong-lane ambient model credentials from
    `$GANTRY_HOME/.env` or the shell.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/repo/boondi-scenarios.test.ts --testNamePattern "basic runtime MCP stack"`
    first failed because `scripts/boondi-runtime-stack.sh` did not strip
    `OPENAI_API_KEY`, then passed after adding that env removal for core,
    Shopify MCP, and CRM MCP child processes.
  - Verification:
    `bash -n scripts/boondi-runtime-stack.sh` passed.
  - The runtime stack no longer passes the generated local smoke control token
    as a positional `node -e` argument. A base64url token can legally start
    with `-`, which Node parses as an option before script arguments; the stack
    now passes the token through `SMOKE_CONTROL_TOKEN` when building
    `GANTRY_CONTROL_API_KEYS_JSON`.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/repo/boondi-scenarios.test.ts --testNamePattern "keeps a checked-in command for the basic runtime MCP stack"`
    first failed on the unsafe `process.argv[1]` token path, then passed after
    switching the JSON builder to `process.env.SMOKE_CONTROL_TOKEN`.
  - Fresh live verification after the local smoke token fix:
    `GANTRY_DEV_LOG=/tmp/gantry-capture.log npm run dev:boondi-runtime`
    reached READY and printed
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env npm run smoke:boondi-runtime`.
    Then
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env SMOKE_CONCURRENCY=3 npm run smoke:boondi-runtime`
    passed with `ok: true`, `concurrency: 3`, one guardrail/MCP request/MCP
    response/outbound event per smoke chat, and `duplicateInbound: true` for
    all three chats. Ctrl-C stopped the stack, the smoke env sidecar was
    removed, ports 4710, 8081, and 8082 were free, and the log signature scan
    found no egress, shutdown, conversation-owner, conversation-work,
    ownership-fence, runtime-event FK, output-callback, or unhandled-error
    matches.
  - Provider rate-limit failures now preserve retry-after diagnostics in
    durable outbound failure state and message-row `delivery_error` projection.
    The stored error remains redacted and length-bounded, but an Interakt-style
    `retryAfterSeconds` value is retained as provider-neutral
    `retry_after_seconds=<n>` metadata for recovery/admin diagnosis.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts --testNamePattern "bounded while preserving retry-after|retry-after metadata"`
    first failed because retry metadata pushed long provider errors beyond the
    delivery-error cap, then passed after budgeting the sanitized base message
    around the retry-after suffix.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts`
    passed 1 file / 70 tests after the rate-limit durability update.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts apps/core/test/unit/channels/interakt.test.ts apps/core/test/unit/jobs/outbound-delivery-recovery.test.ts`
    passed 3 files / 107 tests, covering channel wiring, Interakt 429 parsing,
    and outbound delivery recovery adjacency.
  - Verification:
    `npx tsc --noEmit --pretty false` passed after the rate-limit durability
    update.
  - Verification:
    `git diff --check` passed after the rate-limit durability update.
  - Local hygiene: ports 4710, 8081, and 8082 were free; the removed-switch
    scan found no active legacy provider credential or warm-pool keys in
    `/Users/caw-d/gantry/.env` or `/Users/caw-d/gantry/settings.yaml`.
  - Postgres integration coverage now verifies exact-token
    `releaseLease()` behavior: a wrong version cannot release, the active
    owner token deletes the lease, send-fence verification fails after release,
    and another runtime can claim the same conversation key afterward. It also
    now verifies claim-gate shutdown cleanup against the real owner-lease
    table: tracked leases are released before remaining local owner rows are
    marked `draining`, and another runtime can then take over the draining row.
  - Verification:
    `GANTRY_TEST_DATABASE_URL=<disposable pgvector Postgres> npx vitest run -c vitest.integration.config.ts apps/core/test/integration/conversation-owner-lease.postgres.integration.test.ts`
    passed 7/7 after enabling `vector` and `pg_trgm`; the disposable container
    was removed after the check.
  - Cross-instance conversation-work wakeups now have real Postgres
    `LISTEN/NOTIFY` integration coverage. The tests subscribe through runtime
    notifiers, publish identifier-only conversation-work payloads, verify
    delivery of owner hints over the database channel, verify unsubscribe stops
    local delivery, and run two dispatcher instances against the same
    owner-lease repository so only the hinted current owner, or only one
    unhinted claim winner, enqueues local work.
  - Verification:
    `GANTRY_TEST_DATABASE_URL=<disposable pgvector Postgres> npx vitest run -c vitest.integration.config.ts apps/core/test/integration/conversation-work-notifier.postgres.integration.test.ts`
    passed 1 file / 4 tests after enabling `vector` and `pg_trgm`.
  - Missed-notification recovery now has real Postgres integration coverage:
    the test persists inbound work, does not publish a notification, runs the
    conversation-work reconciler against the real runtime message repository and
    owner-lease repository, verifies the reconciler enqueues only the sanitized
    conversation key, and verifies a competing owner cannot take the lease.
  - The standard `npm run test:integration:postgres` command now includes
    `conversation-work-notifier.postgres.integration.test.ts` and uses a
    self-contained `GANTRY_TEST_DATABASE_URL` prerequisite check instead of a
    `.codex/scripts/` helper that is absent in this linked worktree.
  - Verification:
    `GANTRY_TEST_DATABASE_URL=<disposable pgvector Postgres> npm run test:integration:postgres`
    passed 10 files / 52 tests, 1 skipped after the package-script hardening.
  - Outbound stale-owner fencing now has shared-Postgres integration coverage
    through the production channel-wiring send path. The test persists a
    runtime conversation, lets a stale owner token be superseded by a current
    owner in `conversation_owner_leases`, verifies the stale token is rejected
    before the fake provider adapter sees a send, and verifies the current owner
    token can send.
  - Verification:
    `GANTRY_TEST_DATABASE_URL=<disposable pgvector Postgres> npx vitest run -c vitest.integration.config.ts apps/core/test/integration/outbound-ownership-verifier.postgres.integration.test.ts`
    passed 1 file / 1 test after enabling `vector` and `pg_trgm`.
  - Verification:
    `GANTRY_TEST_DATABASE_URL=<disposable pgvector Postgres> npm run test:integration:postgres`
    passed 11 files / 53 tests, 1 skipped with the outbound stale-fence
    integration included.
  - The standard `npm run test:integration:postgres` command now also includes
    `conversation-owner-lease.postgres.integration.test.ts`, so owner-lease
    takeover, exact release, draining, and claim-gate shutdown cleanup run in
    the shared Postgres gate.
  - Verification:
    `GANTRY_TEST_DATABASE_URL=<disposable pgvector Postgres> npm run test:integration:postgres`
    passed 12 files / 61 tests, 1 skipped with owner-lease and
    missed-notification recovery integration included.
  - Fresh disposable-Postgres verification exposed a stale test-time bug in
    `outbound-ownership-verifier.postgres.integration.test.ts`: the test
    created the "current" owner lease at a fixed historical timestamp, so the
    production send fence correctly treated it as expired when verifying
    against real current time. The test now creates an already-expired stale
    owner relative to the actual test start and a still-valid current owner.
  - Verification:
    `GANTRY_TEST_DATABASE_URL=<disposable pgvector Postgres> npx vitest run -c vitest.integration.config.ts apps/core/test/integration/outbound-ownership-verifier.postgres.integration.test.ts`
    passed 1 file / 1 test after the timing correction.
  - Verification:
    `GANTRY_TEST_DATABASE_URL=<disposable pgvector Postgres> npm run test:integration:postgres`
    passed 12 files / 61 tests, 1 skipped after the outbound-fence timing
    correction; the disposable container was removed after the check.
  - The basic local runtime/MCP stack now supports
    `GANTRY_CORE_COUNT=2 npm run dev:boondi-runtime` for multi-core
    runtime-plumbing smoke against the same runtime home/Postgres. Each core
    gets an adjacent control port, separate log, separate smoke env sidecar,
    and isolated `GANTRY_IPC_SOCKET_PATH` under `GANTRY_RUNTIME_IPC_DIR`, so
    the shared runtime-home IPC socket election does not hide the second core's
    runner path.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/repo/boondi-scenarios.test.ts --testNamePattern "basic runtime MCP stack|multi-core runtime MCP stack"`
    first failed because the stack was single-core only, then passed after
    adding per-core control ports, smoke envs, logs, and IPC sockets.
  - Verification:
    `bash -n scripts/boondi-runtime-stack.sh && node --check scripts/boondi-runtime-smoke.mjs && node --check scripts/lib/runtime-smoke-env.mjs`
    passed after the multi-core stack update.
  - Live two-core stack verification exposed a local harness startup race:
    `GANTRY_CORE_COUNT=2 npm run dev:boondi-runtime` initially started both
    core processes concurrently, and one core failed storage readiness while
    both processes touched shared Postgres migration/readiness paths. The stack
    script now starts each core and waits for its control port before launching
    the next core, and the stale `CORE_URL` smoke switch was removed because
    multi-core health probes are derived from each core's adjacent control port.
  - Verification:
    `GANTRY_CORE_COUNT=2 npm run dev:boondi-runtime` reached
    `READY core_ports=4710 4711 core_codes=404 404 shopify=ok crm=ok` after
    the sequential-startup fix.
  - Verification:
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env.1 SMOKE_CONCURRENCY=3 npm run smoke:boondi-runtime`
    passed against core 4710 for Shopify, Shopify secondary, and CRM cases with
    guardrail, MCP request, MCP response, outbound dry-run, and duplicate
    inbound checks.
  - Verification:
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env.2 BOONDI_SMOKE_SHOPIFY_PHONE=000000031 BOONDI_SMOKE_SHOPIFY_SECONDARY_PHONE=000000032 BOONDI_SMOKE_CRM_PHONE=000000052 SMOKE_CONCURRENCY=1 TURN_TIMEOUT_MS=240000 npm run smoke:boondi-runtime`
    passed against core 4711 for Shopify, Shopify secondary, and CRM cases with
    guardrail, MCP request, MCP response, outbound dry-run, and duplicate
    inbound checks.
  - Caveat:
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env.2 BOONDI_SMOKE_SHOPIFY_PHONE=000000023 BOONDI_SMOKE_SHOPIFY_SECONDARY_PHONE=000000024 BOONDI_SMOKE_CRM_PHONE=000000051 SMOKE_CONCURRENCY=3 npm run smoke:boondi-runtime`
    hit warm-worker bind timeouts before retry/fallback output on core 4711.
    Basic inbound/outbound/MCP plumbing was already proven on both cores; the
    root cause and closure for this concurrency caveat are captured below.
  - The local three-warm-worker concurrency failure was caused by fail-fast
    target-size replenishment: one generic warm worker boot timeout rejected the
    shared `prewarm(size)` promise for every concurrent caller, even when sibling
    warm workers later became usable. `WarmPoolManager` now waits for all target
    boot attempts, retains successful workers on partial failure, and schedules
    replenishment for the missing capacity; it still throws when every target
    boot fails.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/warm-pool-manager.test.ts --testNamePattern "keeps successful workers"`
    first failed because partial prewarm rejected with
    `worker startup timed out`, then passed after the replenishment fix.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/warm-pool-manager.test.ts`
    passed 20 tests after the replenishment fix.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/agent-spawn.test.ts --testNamePattern "warm pool|warm worker|prewarm"`
    passed 7 selected warm-spawn tests, and
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/startup.test.ts --testNamePattern "warm"`
    passed 3 selected warm-startup tests.
  - Verification:
    `GANTRY_CORE_COUNT=2 npm run dev:boondi-runtime` reached
    `READY core_ports=4710 4711 core_codes=404 404 shopify=ok crm=ok`, then
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env.2 BOONDI_SMOKE_SHOPIFY_PHONE=000000064 BOONDI_SMOKE_SHOPIFY_SECONDARY_PHONE=000000065 BOONDI_SMOKE_CRM_PHONE=000000050 SMOKE_CONCURRENCY=3 TURN_TIMEOUT_MS=240000 npm run smoke:boondi-runtime`
    passed against core 4711 with all three cases reporting guardrail, MCP
    request, MCP response, outbound dry-run, and duplicate inbound checks.
  - Verification:
    log scan across `/tmp/gantry-dev-1.log`, `/tmp/gantry-dev-2.log`,
    `/tmp/mcp-shopify-dev.log`, and `/tmp/mcp-crm-dev.log` found no
    `Timed out waiting 30000ms`, `Warm worker bind failed`, `Agent error`,
    `Cannot connect to postgres`, `EADDRINUSE`, `runtime_events_run_id_fkey`,
    or `unhandled` after the passing live run; ports 4710, 4711, 8081, and 8082
    were free after stack shutdown.
  - The standard `npm run test:integration:postgres` command now includes the
    existing `runtime-worker-inventory.postgres.integration.test.ts`, so
    per-instance worker inventory persistence is part of the shared Postgres
    gate instead of relying only on unit/control-route coverage.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/repo/package-hygiene.test.ts --testNamePattern "runtime worker inventory"`
    passed after locking the package-script entry.
  - Active message runs now heartbeat their tracked conversation-owner lease
    while processing is in flight. This prevents long model/tool waits from
    looking abandoned and being reclaimed by another core before the original
    owner reaches the outbound send fence.
  - Warm workers are now admitted to the pool only after the runner's bind
    socket is reachable, and warm-pool health checks also require socket
    readiness. A cache-ready-but-not-bind-ready process is no longer treated as
    available capacity.
  - Multi-core runner spawn now preserves the per-core
    `GANTRY_IPC_SOCKET_PATH`, so core-specific workers connect to the matching
    IPC socket instead of falling back to another core's default runtime-home
    socket.
  - Prewarm-only Anthropic runs now skip caller-identity projection for
    HTTP/SSE MCP capabilities. The customer identity for those MCP calls is
    signed through the Gantry facade at bind/live-run time; a generic
    customer-free prewarm should not require a fake WhatsApp JID.
  - The local runtime smoke now accepts `SMOKE_CASES` and validates that
    `/v1/runtime/workers` exposes the expected number of healthy runtime
    instances. The CRM smoke case remains an inbound/outbound health check
    without requiring an agent MCP turn when the guardrail path can answer
    directly.
  - Local Control API bearer auth was added directly to
    `/Users/caw-d/gantry/.env` as `GANTRY_SMOKE_CONTROL_TOKEN`, matching the
    existing `local-dev-owner` key in `GANTRY_CONTROL_API_KEYS_JSON` with
    `sessions:read` scope for runtime worker inventory probes.
  - Focused verification after the bind-readiness, heartbeat, latency-trace,
    and smoke-env updates passed:
    `npx vitest run -c vitest.unit.config.ts --no-file-parallelism apps/core/test/unit/adapters/anthropic-warm-pool.test.ts apps/core/test/unit/runtime/warm-bind-delivery.test.ts apps/core/test/unit/bootstrap/startup.test.ts apps/core/test/unit/runtime/agent-spawn.test.ts apps/core/test/unit/runtime/conversation-work-claim-gate.test.ts apps/core/test/unit/runtime/group-queue.test.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/repo/boondi-scenarios.test.ts`
    passed 9 files / 383 tests.
  - Verification:
    `npm run typecheck -- --pretty false` passed, and
    `bash -n scripts/boondi-runtime-stack.sh && node --check scripts/boondi-runtime-smoke.mjs && node --check scripts/lib/runtime-smoke-env.mjs`
    passed.
  - Fresh two-core runtime-plumbing smoke passed against
    `GANTRY_CORE_COUNT=2 npm run dev:boondi-runtime`. Core 4710 smoke with
    `SMOKE_CASES=shopify,crm` and fresh phones `000000100`/`000000101` passed;
    core 4711 smoke with fresh phones `000000102`/`000000103` also passed.
    Shopify produced guardrail, agent MCP request/response, outbound dry-run,
    and duplicate-inbound suppression on both cores. CRM produced guardrail,
    outbound dry-run, and duplicate-inbound suppression on both cores.
  - Reply-trace evidence for the fresh two-core smoke showed no
    `cache_prewarm` or `startup` section in customer reply totals:
    Shopify replies were about 9.254s and 10.297s with
    `["queue","guardrail","llm","gap","tool","llm","gap"]` / send sections,
    while CRM guardrail replies were about 0.043s and 0.037s with
    `["queue","guardrail","gap"]`.
  - Local runtime env/template cleanup removed the obsolete `IDLE_TIMEOUT`
    placeholder from `.env.example`; live runner retention is settings-owned
    through `runtime.runner.idle_timeout_ms`.
  - `/Users/caw-d/gantry/settings.yaml` was backed up to
    `/Users/caw-d/gantry/settings.yaml.codex-backup-20260617T161227Z` and now
    explicitly carries non-secret runtime queue, ownership, and trace-retention
    defaults alongside the existing runner and warm-pool settings. Follow-up
    redacted scans showed no active `GANTRY_WARM_POOL`,
    `GANTRY_WARM_POOL_CACHE_PROBE`, `IDLE_TIMEOUT`, `ANTHROPIC_API_KEY`,
    `OPENAI_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` entries in
    `/Users/caw-d/gantry/.env` or `/Users/caw-d/gantry/settings.yaml`.
  - `scripts/boondi-runtime-stack.sh` now tolerates shell-quoted
    `GANTRY_CONTROL_API_KEYS_JSON`, tracks the smoke token per core, and
    rewrites each `GANTRY_RUNTIME_SMOKE_ENV` sidecar immediately before
    printing the `Next:` smoke command. This closes the local failure where the
    stack reached READY but the advertised sidecar was missing.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/public-runtime-settings.test.ts apps/core/test/unit/architecture/runtime-switch-reference.test.ts`
    passed 3 files / 84 tests.
  - Verification:
    `bash -n scripts/boondi-runtime-stack.sh && node --check scripts/boondi-runtime-smoke.mjs && node --check scripts/lib/runtime-smoke-env.mjs`
    passed.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/repo/boondi-scenarios.test.ts --testNamePattern "basic runtime MCP stack|local multi-core runtime MCP stack"`
    passed 2 selected tests.
  - Fresh single-core local runtime-plumbing smoke passed after restarting
    `GANTRY_CORE_COUNT=1 npm run dev:boondi-runtime` from this checkout. The
    stack reached `READY core_ports=4710 core_codes=404 shopify=ok crm=ok`,
    created `/tmp/gantry-runtime-smoke.env` with `0600` permissions, and
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env npm run smoke:boondi-runtime`
    returned `ok: true`: Shopify primary, Shopify secondary, and CRM each had
    one guardrail event, one MCP request, one MCP response, one outbound dry-run
    event, and duplicate-inbound suppression.
  - Active owner-lease heartbeat cadence is now settings-owned as
    `runtime.ownership.heartbeat_interval_ms` instead of being derived from
    `lease_ttl_ms / 3` in runtime startup. `/Users/caw-d/gantry/settings.yaml`
    was backed up to
    `/Users/caw-d/gantry/settings.yaml.codex-backup-20260617T162755Z` and now
    explicitly sets `runtime.ownership.heartbeat_interval_ms: 15000` for local
    startup.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/config/runtime-settings.test.ts apps/core/test/unit/config/public-runtime-settings.test.ts apps/core/test/unit/architecture/runtime-switch-reference.test.ts`
    first failed because `runtime.ownership.heartbeat_interval_ms` was not
    parsed, rendered, exposed publicly, or documented, then passed after adding
    the settings-owned heartbeat interval.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/bootstrap/runtime-app.test.ts apps/core/test/unit/runtime/conversation-work-claim-gate.test.ts --testNamePattern "ownership|heartbeat|wires"`
    passed 2 files / 6 selected tests.
  - Verification:
    `npm run typecheck -- --pretty false` passed after the ownership heartbeat
    setting change.
  - Fresh single-core local runtime-plumbing smoke passed after restarting
    `GANTRY_CORE_COUNT=1 npm run dev:boondi-runtime` with
    `runtime.ownership.heartbeat_interval_ms: 15000` loaded from
    `/Users/caw-d/gantry/settings.yaml`. The stack reached
    `READY core_ports=4710 core_codes=404 shopify=ok crm=ok`, and
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env npm run smoke:boondi-runtime`
    returned `ok: true`: Shopify primary, Shopify secondary, and CRM each had
    one guardrail event, one MCP request, one MCP response, one outbound dry-run
    event, and duplicate-inbound suppression.
  - `scripts/measure-latency.mjs` now ignores warm-pool workers and orphaned
    `/gantry-runner-test-*` fixture runners during slot isolation. The first
    focused latency attempt against the healthy local stack skipped T3 because
    stale test PID `27435` from `/var/folders/.../gantry-runner-test-*` was
    incorrectly treated as active customer queue pressure; the corrected harness
    limits isolation to live customer-turn runners.
  - Focused latency measurement against the held local stack passed:
    `GANTRY_DEV_LOG=/tmp/gantry-capture.log LATENCY_TURN_TIMEOUT_MS=180000 node scripts/measure-latency.mjs --samples 1 --only T3 --json /tmp/latency-suite-phase8-t3.json`
    reported T3 product lookup `1/1`, total `8836ms`, guardrail pickup `38ms`,
    MCP total `1055ms`, post-result tail `118ms`, two LLM rounds, first-round
    cache write `6771`, and first-round cache read `3238`.
  - Admin/API proof for the same `000000043` sample showed
    `replySeconds: 8.836`, `latencyTotal: 8836`, and latency sections
    `["queue","llm","gap","tool","llm","gap"]`. Direct Postgres trace
    inspection showed only `144ms` total `gap` time and no `cache_prewarm` or
    `startup` section in the customer reply trace. Flow logs also showed the
    route warm-pool prewarm completed for `wa:000000043` before the customer
    message was processed.
  - Full one-sample latency matrix against the same held stack passed:
    `GANTRY_DEV_LOG=/tmp/gantry-capture.log LATENCY_TURN_TIMEOUT_MS=180000 node scripts/measure-latency.mjs --samples 1 --json /tmp/latency-suite-phase8-full-s1.json`.
    Raw harness totals were: T1 greeting `708ms`, T2 policy `3883ms`, T3
    product lookup `7827ms`, T4 warm follow-up `20450ms`, and T5 order status
    `71785ms`. The same JSON recorded spawn-to-LLM delay as T2 `107ms`, T3
    `115ms`, T4 `10858ms`, and T5 `116ms`; the T4 outlier was therefore hidden
    by the old printed table, which did not show `spawnToLlmInputMs`.
  - Admin/API and direct trace proof for the latest matrix outbounds matched
    the live totals closely: `000000041` replySeconds `0.698` /
    latencyTotal `605`, `000000042` `3.882` / `3886`, `000000043` `20.449` /
    `20447`, and `000000044` `71.785` / `71784`.
  - The "gap surged" hypothesis was not supported by persisted trace data.
    Latest trace gap totals were `22ms` for `000000041`, `134ms` for
    `000000042`, `181ms` for `000000043`, and `140ms` for `000000044`.
    No latest customer reply trace contained a `cache_prewarm` section.
  - T4/T5 remain latency problems, but the current evidence points elsewhere:
    T4 saw warm-pool depletion/run-time prewarm before first LLM input, and T5
    contained `startup:5142ms` plus a second `llm:60700ms` provider/model wait.
    Flow logs showed `Warm pool empty; prewarming before run` for the T4/T5
    sequence. This is a warm capacity/provider-time issue, not a trace-gap or
    cache-prewarm-attribution issue.
  - `scripts/measure-latency.mjs` now prints `spawn` in both the per-turn line
    and summary table so future Phase 8 latency runs expose run-time
    prewarm/bind delay without opening the JSON detail file.
  - Warm-pool keying no longer includes the provider resume session id, and
    generic warm boot input deletes `sessionId` before starting the SDK worker.
    The provider session is now carried only in the later bind scope. This
    keeps generic prewarm capacity reusable across first replies and follow-ups
    with the same cache shape instead of fragmenting the pool per saved SDK
    session.
  - Follow-up fix after the admin latency report: completed warm-bound runners
    now keep the idle timeout alive after the streamed reply has already been
    delivered, and terminal warm replies use the existing queue stop path at
    idle timeout instead of relying only on a soft stdin close. This prevents
    already-completed retained runners from occupying `max_bound_workers` for
    ~50-60s and forcing later customers onto cold startup. Accepted
    continuations cancel the preserved idle timer so the previous turn cannot
    stop the active follow-up.
  - Focused verification for the warm-runner reclaim fix passed:
    `npx vitest run apps/core/test/unit/runtime/group-processing.test.ts --no-file-parallelism`,
    `npx vitest run apps/core/test/unit/runtime/group-queue.test.ts --no-file-parallelism`,
    and `npm run typecheck`.
  - Fresh local stack verification after the reclaim fix reached
    `READY core_ports=4710 core_codes=404 shopify=ok crm=ok`. A follow-up
    `GANTRY_DEV_LOG=/tmp/gantry-capture.log LATENCY_TURN_TIMEOUT_MS=180000 node scripts/measure-latency.mjs --samples 2 --only T3,T4 --json /tmp/latency-suite-phase8-t3t4-reclaim-s2.json`
    run showed T4 spawn-to-LLM delay stayed low (`88ms`, `81ms`), but customer
    totals still had provider/model outliers (`T4` totals `11466ms` and
    `69969ms`). Direct trace inspection showed the large remaining waits were
    LLM provider waits, including one `llm` section with `providerWaitMs:
    61254`; this is not cache-prewarm attribution.
  - The same T3/T4 follow-up run still showed one startup section when the pool
    was empty under the two-sample cadence. That remaining issue is capacity
    sizing/top-up behavior under `runtime.warm_pool.max_bound_workers`, not
    CRM/Shopify semantic behavior. Do not treat that as fixed until a larger
    multi-sample run shows no customer-turn `startup` sections for warm-capable
    replies.
  - boondi-admin verification was operational, not a code delta: the existing
    admin commit already had the runtime route/error fallbacks and `.env.local`
    pointed at `http://127.0.0.1:4710`. A clean dev-server restart repaired the
    `/leads` `missing required error components` page and `/runtime` Control API
    fetch banner. Admin checks passed with `npm run build`, `npx tsc --noEmit`,
    and
    `PORT=3000 npm run test:e2e -- e2e/runtime-workers.spec.ts e2e/leads-memory.spec.ts --project=chromium`.
  - `scripts/measure-latency.mjs` now prints `llmSum` and `llmMax` beside
    `spawn`, `mcp`, and `tail`, so provider/model wait is visible in the CLI
    summary instead of hidden in the JSON detail or admin trace modal.
  - Verification:
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/repo/boondi-scenarios.test.ts --testNamePattern "latency measurement summary"`
    passed, and `node --check scripts/measure-latency.mjs` passed.
  - Fresh single-core runtime-plumbing smoke passed against
    `GANTRY_CORE_COUNT=1 GANTRY_DEV_LOG=/tmp/gantry-capture.log npm run dev:boondi-runtime`:
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env npm run smoke:boondi-runtime`
    returned `ok: true`; Shopify primary, Shopify secondary, and CRM each had
    one guardrail event, one MCP request, one MCP response, one outbound dry-run
    event, and duplicate-inbound suppression.
  - Fresh one-sample T1-T5 latency matrix against the same held stack passed:
    `GANTRY_DEV_LOG=/tmp/gantry-capture.log LATENCY_TURN_TIMEOUT_MS=180000 node scripts/measure-latency.mjs --samples 1 --json /tmp/latency-suite-phase8-provider-columns-s1.json`.
    Raw totals were T1 `61ms`, T2 `2349ms`, T3 `13360ms`, T4 `14893ms`, and
    T5 `8849ms`. Spawn-to-LLM delay stayed low for all model turns (`101ms`,
    `59ms`, `61ms`, `104ms`). Provider/model round time was the dominant
    measured cost for model-backed turns: `llmSum` T2 `2059ms`, T3 `12575ms`,
    T4 `7095ms`, and T5 `5823ms`. This confirms the latest local customer-side
    latency issue is not trace `gap`, runtime startup, or cache-prewarm
    attribution on this sample.
  - `scripts/boondi-runtime-smoke.mjs` now prints capacity evidence in its
    machine-readable JSON output: worker inventory healthy totals before and
    after the smoke, warm-worker RSS totals and per-PID RSS, per-case `replyMs`,
    and the latest model-rate-limit snapshot when the model emits one. This
    keeps the provider-sizing gate attached to the signed-webhook runtime smoke
    instead of a separate ad hoc checklist.
  - Verification:
    `node --check scripts/boondi-runtime-smoke.mjs` passed; focused
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/repo/boondi-scenarios.test.ts --testNamePattern "basic runtime smoke|multi-instance worker inventory"`
    passed.
  - Fresh single-core runtime smoke with the capacity fields passed:
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env npm run smoke:boondi-runtime`
    returned `ok: true`, one healthy runtime instance, before/after warm-worker
    RSS snapshots, per-case `replyMs`, and `modelRateLimit: null` for all smoke
    cases. Shopify primary, Shopify secondary, and CRM each still produced one
    guardrail event, one MCP request, one MCP response, one outbound dry-run
    event, and duplicate-inbound suppression.
  - Fresh local three-worker runtime smoke passed against the same held stack:
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env SMOKE_CONCURRENCY=3 npm run smoke:boondi-runtime`
    returned `ok: true`, `concurrency: 3`, one healthy runtime instance, and
    before/after worker inventory with `genericAvailable: 6`,
    `genericStarting: 0`, and `maxBoundWorkers: 3`. Per-case reply times were
    Shopify primary `11868ms`, Shopify secondary `12239ms`, and CRM `6871ms`;
    all three model-rate-limit snapshots were `null`. Warm-worker RSS was
    captured before (`6` workers, `355344KB` total, `87216KB` max) and after
    (`6` workers, `529984KB` total, `259856KB` max). This gives the local
    provider-capacity gate concrete RSS/reply-time/rate-limit evidence for
    concurrency `3` without asserting CRM or Shopify semantic behavior.
  - The runtime smoke now supports `SMOKE_CASE_COUNT` for provider sizing runs
    above the default three cases. Extra cases are generated from the selected
    runtime-plumbing templates using `000`-prefixed fake phone numbers, so
    `SMOKE_CONCURRENCY=5 SMOKE_CASE_COUNT=5` truly drives five independent
    signed-webhook conversations instead of only raising the worker-pool size
    over three cases.
  - Verification:
    `node --check scripts/boondi-runtime-smoke.mjs` passed; focused
    `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/repo/boondi-scenarios.test.ts --testNamePattern "basic runtime smoke"`
    passed.
  - Fresh local provider-sizing smoke passed against
    `GANTRY_CORE_COUNT=1 GANTRY_DEV_LOG=/tmp/gantry-capture.log npm run dev:boondi-runtime`:
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env SMOKE_CONCURRENCY=5 SMOKE_CASE_COUNT=5 TURN_TIMEOUT_MS=240000 npm run smoke:boondi-runtime`
    returned `ok: true`, `concurrency: 5`, and `caseCount: 5`. The five
    independent fake-phone cases all produced guardrail, MCP request/response,
    outbound dry-run, and duplicate-inbound suppression. Reply times were
    `20072ms`, `11393ms`, `9322ms`, `8467ms`, and `80679ms`; all model-rate
    snapshots were `null`. Worker inventory before/after remained one healthy
    runtime instance with `genericAvailable: 6`, `genericStarting: 0`, and
    `maxBoundWorkers: 3`. Warm-worker RSS was captured before (`6` workers,
    `329824KB` total, `55088KB` max) and after (`6` workers, `1031728KB`
    total, `356352KB` max). Log scan after shutdown found no egress,
    listener, ownership, runtime-event FK, output-callback, warm-bind,
    Postgres, or unhandled-error signatures; ports `4710`, `4711`, `8081`, and
    `8082` were free.
  - Multi-instance stale-notification takeover coverage was tightened in the
    real Postgres notification bridge. A new integration case starts two
    dispatcher instances, lets one instance's lease expire, has the other
    instance take over, then publishes a notification carrying the stale owner
    hint. Only the current owner enqueues work; the old owner is not
    resurrected, and customer text stays out of the notification/enqueue
    payload.
  - Verification:
    `GANTRY_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55002/gantry_test' npx vitest run -c vitest.integration.config.ts apps/core/test/integration/conversation-owner-lease.postgres.integration.test.ts apps/core/test/integration/conversation-work-notifier.postgres.integration.test.ts apps/core/test/integration/outbound-ownership-verifier.postgres.integration.test.ts apps/core/test/integration/runtime-worker-inventory.postgres.integration.test.ts`
    passed `4` files / `15` tests against disposable Postgres container
    `3849d6f8dc8c6b0a25567e3988b5cdfa1be7a252f3ef176d5e628ff47655f064`,
    which was removed after the run. This covers owner lease takeover/release,
    two-dispatcher notification routing, missed notification recovery, stale
    owner-hint takeover, outbound send fencing, and per-instance worker
    inventory persistence.
  - Fresh local server-readiness verification passed after the admin/env audit
    reported a transient `dev:boondi-runtime` failure. Reproduction from this
    checkout with
    `GANTRY_CORE_COUNT=1 GANTRY_DEV_LOG=/tmp/gantry-capture.log npm run dev:boondi-runtime`
    reached `READY core_ports=4710 core_codes=404 shopify=ok crm=ok`; the
    follow-up
    `GANTRY_RUNTIME_SMOKE_ENV=/tmp/gantry-runtime-smoke.env GANTRY_DEV_LOG=/tmp/gantry-capture.log npm run smoke:boondi-runtime`
    returned `ok: true`, `concurrency: 1`, and `caseCount: 3`. Shopify
    primary, Shopify secondary, and CRM each produced one guardrail event, one
    MCP request, one MCP response, one outbound dry-run event, and
    duplicate-inbound suppression. Reply times were `9635ms`, `11441ms`, and
    `6563ms`; all model-rate-limit snapshots were `null`. Shutdown log scan
    found no egress, listener, ownership, runtime-event FK, output-callback,
    warm-bind, Postgres, unhandled-error, or malformed Control API key
    signatures; ports `4710`, `4711`, `8081`, and `8082` were free afterward.
  - Admin runtime UI verification was tightened in the approved sibling
    `boondi-admin` app. `e2e/runtime-workers.spec.ts` now mocks multiple
    runtime instances and asserts that the Runtime tab renders both healthy and
    stale instance rows, hostnames, and the healthy-runtime total. Verification:
    `npm run test:e2e -- e2e/runtime-workers.spec.ts --project=chromium`
    passed `3` tests in `/Users/caw-d/Desktop/boondi-admin`.
  - Fresh two-core runtime-plumbing smoke passed against
    `GANTRY_CORE_COUNT=2 GANTRY_DEV_LOG=/tmp/gantry-capture.log npm run dev:boondi-runtime`.
    Both generated smoke env files reported `GANTRY_EXPECTED_RUNTIME_INSTANCES=2`;
    core `4710` and core `4711` each returned `ok: true`, `concurrency: 1`,
    and `caseCount: 3` with `workerInventory.before.instances=2` and
    `workerInventory.after.instances=2`. Shopify primary, Shopify secondary,
    and CRM each produced one guardrail event, one MCP request, one MCP
    response, one outbound dry-run event, and duplicate-inbound suppression on
    the corrected core-2 run. Reply times were core 1 `15921ms`, `11409ms`,
    and `7321ms`; core 2 `8516ms`, `8649ms`, and `6975ms`. The shutdown log
    scan found no egress, listener, ownership, runtime-event FK,
    output-callback, warm-bind, Postgres, unhandled-error, timeout, agent-error,
    or malformed Control API key signatures; ports `4710`, `4711`, `8081`, and
    `8082` were free afterward.
  - Live admin verification passed after adding
    `NEXT_PUBLIC_SHOULD_ALLOW_CHAT_DEV=1` to `/Users/caw-d/Desktop/boondi-admin/.env.local`
    and restarting the stale local admin server. Browser verification against a
    fresh `GANTRY_CORE_COUNT=1 GANTRY_DEV_LOG=/tmp/gantry-capture.log npm run dev:boondi-runtime`
    plus `npm run dev` in `/Users/caw-d/Desktop/boondi-admin` showed `/runtime`
    rendering healthy worker inventory with no Control API fetch banner and
    `/leads` rendering the leads UI with no `missing required error components`
    text. Browser warning/error logs were empty for both pages.
  - Final gates passed: `npm run build`, `npm run typecheck`,
    `npm run test:unit` (`367` files / `3775` tests), and
    `GANTRY_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:<port>/gantry_test' npm run test:integration:postgres`
    (`13` files / `64` passed / `1` skipped) against disposable Postgres
    container `gantry-it-1781723243` with `vector` and `pg_trgm` installed. The
    disposable container was removed after the run.
Deferred follow-ups:
  - Continue Boondi latency measurement with `scripts/measure-latency.mjs` and
    boondi-admin `replySeconds` across multiple T1-T5 samples; the broad
    regression harness remains a correctness gate for visible replies, routing,
    guardrails, privacy, and tool calls. Any further warm-pool capacity/top-up
    work is provider-sizing or SLA tuning, not a blocker for current
    inbound/outbound/MCP runtime plumbing completion.
  - Full Boondi semantic scenario gates are useful product regression checks,
    but they are not the current runtime-plumbing gate. For local server
    readiness, use the signed-webhook smoke plus MCP request/response evidence
    above before chasing CRM/Shopify behavior details.
  - Broader production chaos drills can still be added later, but the current
    runtime-generic Postgres bridge gate is covered by duplicate/no-owner
    dispatch, missed notification recovery, current-owner routing,
    stale-owner-hint takeover, outbound send fencing, per-instance worker
    inventory integration tests, and the two-core local smoke above.
```

#### Summary (plain English)

Lock the production contract: where switches live, how shutdown hands off
ownership, how failures are tested, and how the full Boondi path is verified.

#### Detailed step-by-step plan & procedure

1. Produce a switch reference for `.env`, `settings.yaml`, and code defaults.
   For every switch include:
   - owner surface;
   - default value;
   - dev recommendation;
   - production recommendation;
   - restart requirement;
   - latency/correctness impact.

2. Put non-secret runtime behavior in `settings.yaml` where possible:

   ```yaml
   runtime:
     queue:
       max_message_runs: ...
     warm_pool:
       available_size: ...
       max_bound_workers: ...
       cache_prewarm_enabled: ...
       cache_prewarm_concurrency: ...
     ownership:
       lease_ttl_ms: ...
       heartbeat_interval_ms: ...
       reconciler_interval_ms: ...
   ```

3. If `runtime.queue.max_message_runs` is absent, default it to
   `runtime.warm_pool.available_size` once that setting exists. Keep them
   separately configurable because queue concurrency and warm worker inventory
   are related but not identical.

4. Extend graceful shutdown:
   - stop claiming new leases;
   - mark local leases draining;
   - allow active sends/runs to finish within the shutdown grace period;
   - release leases that finished cleanly;
   - rely on short lease expiry for hard-killed instances.

5. Add chaos tests:

   ```text
   duplicate Interakt webhook -> one message and one reply
   missed NOTIFY -> reconciler processes persisted message
   worker dies -> same owner rebuilds from durable state
   server dies -> lease expires and another instance takes over
   expired lease mid-run -> stale owner fenced before outbound send
   provider send succeeds but settlement fails -> no blind duplicate reply
   Interakt 429/retry failure -> durable recovery behavior is correct
   graceful shutdown -> no new claims, active leases drain/release
   ```

6. Add production readiness tests:
   - two or more Gantry instances against the same Postgres database;
   - one instance receives webhook while another owns the conversation;
   - missed notification recovery with listener disconnected;
   - lease takeover while old worker is still alive;
   - stale owner blocked before provider send, outbound recovery send, and
     side-effecting tool write;
   - graceful shutdown during active run;
   - bound-worker overload queues work and exposes diagnostics;
   - provider rate-limit or model-wait pressure is visible in latency sections;
   - admin dashboard shows multiple instance worker snapshots and hides or marks
     stale instances.

7. Add a provider credential sizing gate before increasing warm-pool size beyond
   the local hypothesis value of 3:
   - measured per-worker RSS;
   - measured LLM wait under 1, 3, and 5 concurrent conversations;
   - observed Anthropic/provider rate-limit events;
   - prewarm probe concurrency and budget;
   - max live turns allowed per credential.

8. Run final dev verification using the project guidance:
   - relevant unit tests;
   - relevant Postgres integration tests with disposable Postgres;
   - architecture checks from `docs/architecture/current-verification-commands.md`;
   - local three-warm-worker concurrency run;
   - full `docs/BOONDI-E2E-TESTING.md` dev run.

9. Run final production-readiness verification:
   - multi-instance local/integration harness;
   - chaos test matrix;
   - admin dashboard multi-instance observability test;
   - provider-capacity sizing report.

#### Acceptance criteria (plain English)

- Runtime switches are documented and have one clear owner.
- Graceful shutdown is ownership-aware.
- Chaos tests cover the important duplicate, crash, missed-notify, takeover,
  send-fencing, and recovery cases.
- `docs/BOONDI-E2E-TESTING.md` runs cleanly end to end.
- The admin dashboard shows a detailed per-stage latency breakdown for the
  whole inbound-to-outbound pipeline.
- The admin dashboard shows per-instance warm-worker and active-worker counts.
- Local verification proves the three-warm-pool concurrency hypothesis before
  increasing pool size or moving to AWS scale-out.
- Multi-instance production-readiness tests pass against shared Postgres.
- Provider credential sizing is measured before production warm-pool values are
  increased.
- Exact payload observability is disabled by default in production and guarded
  by admin access, audit, redaction, size limits, and retention.

## Final Surface Impact Matrix

| Surface                      | Status               | Reason                                                                                                                                |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed              | Routing resolution, distributed ownership, event wakeup, sticky workers, cache prewarm, and outbound fencing change runtime behavior. |
| `settings.yaml`              | Changed              | Non-secret runtime queue, warm-pool, ownership, and prewarm settings should live here.                                                |
| `.env`                       | Changed              | Secret/credential flags and dev-only trace toggles remain env-owned; dead or duplicate envs should be removed during switch audit.    |
| Postgres/runtime projection  | Changed              | Adds owner lease table, notification/reconciler state, and potentially richer trace payload storage.                                  |
| Control API                  | Read-only/observable | No first implementation API mutation is required, but observability endpoints may expose richer trace details.                        |
| SDK/contracts                | Changed              | Anthropic adapter must support cache prewarm and exact cache payload capture.                                                         |
| CLI                          | Unchanged by design  | No CLI workflow is required for the core architecture change.                                                                         |
| Gantry MCP tools/admin skill | Unchanged by design  | No admin-tool authority change is required.                                                                                           |
| Channel/provider adapters    | Changed              | Interakt routing uses provider default as virtual route; outbound sends gain lease fencing.                                           |
| Docs/prompts                 | Changed              | This plan and the switch reference become implementation guidance.                                                                    |
| Audit/events                 | Changed              | Adds webhook, persistence, dedupe, notify, lease, fence, recovery, worker, and cache events/sections.                                 |
| Tests/verification           | Changed              | Requires unit, Postgres integration, admin e2e, chaos, and Boondi E2E verification.                                                   |

## Implementation Notes To Preserve

- A route is routing configuration, not conversation history. It maps a
  conversation id to an agent binding.
- `GroupQueue` decides local scheduling and per-conversation serialization; it
  does not own durable messages.
- Postgres `LISTEN/NOTIFY` wakes servers; Postgres rows decide truth.
- Provider SDK session resume is an optimization. Durable Gantry state is the
  continuity source of truth.
- One Claude Code OAuth credential can issue concurrent requests, but it does
  not create independent model capacity. Warm-pool and prewarm concurrency must
  be capped by real provider credential capacity.
