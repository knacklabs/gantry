# Coordination-Representation Audit — 2026-07-18

Read-only audit triggered by the C+D (#228) durable-question churn: ~9 review
rounds kept finding the *same class* of bug (concurrent writers lose a sibling;
a reader's key-path doesn't match the writer's). Root cause turned out to be a
**representation** choice, not a logic bug — so we swept the rest of the tree
for siblings ("check anything over-complicated causing the errors").

## Root-cause pattern

Three shapes of the same disease — durable coordination state represented
*informally* instead of with a primitive the database enforces:

1. **State machine encoded as which jsonb keys are present** in a blob column,
   with the SQL writer and N TypeScript readers as two hand-kept copies of one
   schema. A wrong shape is still valid jsonb → nothing errors → silent
   misbehaviour (dead buttons / dropped decision).
2. **Hand-rolled coordination** (CAS loops, hand-built leases, list-scans,
   process-local Maps/Sets that gate durable behaviour) where a DB primitive
   (unique index, atomic conditional `UPDATE`, `ON CONFLICT`, advisory lock,
   `FOR UPDATE`) is simpler and correct.
3. **Denormalized copies kept in sync by hand** — a shared object duplicated
   into N rows and compared by `JSON.stringify` (order-sensitive vs jsonb
   round-trip), or a protocol hand-copied across the four channel providers.

## Headline: the disease is CONTAINED, not systemic

Three parallel sweeps (state-in-jsonb, hand-rolled coordination, denormalized
duplication) confirmed the codebase is **unusually disciplined**: nearly every
durable table already uses real `status`/`state` columns + partial unique
indexes + `FOR UPDATE SKIP LOCKED` + fencing-token leases + advisory locks +
`ON CONFLICT`. **We are refactoring toward an existing in-repo pattern, not
inventing one.** The clean tables are listed at the bottom so they are not
re-audited.

Nothing below is a live single-host data-loss bug *today*. These are the
bug-generators that produce the churn under concurrency / restart / multi-host.

---

## Group A — Permission durable-storage subsystem

The C+D churn root cause. The app-layer claim *call* is already consolidated
(one `claimPendingPermissionCallbackRows`); the problem is the **SQL
representation** and the **provider-side recovery wrappers**. Sequence these as
one cycle: **Permission durable-storage simplification** (distinct from the
permission *decision* simplification in `permission-simplification-goal-prompt.md`).

### A1 · HIGH — recovery protocol hand-copied across all four providers (drift started)
The "recover a permission decision after channel restart" protocol is
byte-duplicated per provider, including a decision-reconstruction fn and a
claim-equality fn, and re-implements the shared `samePermissionClaim`:
- `apps/core/src/channels/discord-permission-callback.ts:100-219` (+ `recoveredDiscordPermissionDecision:205-219`)
- `apps/core/src/channels/telegram/permission-callback.ts:62-187` (+ `recoveredTelegramPermissionDecision:243-257`)
- `apps/core/src/channels/slack/channel-interactions.ts:~310-389` (+ `recoveredSlackPermissionDecision:636-654`, `samePermissionCallback:623-634`)
- `apps/core/src/channels/teams-interaction-handlers.ts:~250-291` (+ `recoveredTeamsPermissionDecision:546-564`, `sameTeamsPermissionCallback:533-544`)
- shared helper already exists: `apps/core/src/application/interactions/pending-interaction-permission-claim.ts:73-83` (`samePermissionClaim`)

**Failure mode (security-adjacent):** a fix to the gating rule applied to 3-of-4
leaves one channel approving permissions under different rules, visible only on
that channel after restart. Divergence has ALREADY begun: Discord/Telegram key
recovery off `prompt.claim`, Slack/Teams off `durable.claim`; entry conditions
differ per file.

**Target shape:** one `recoverDurablePermissionDecision(hooks)` in the
application layer taking provider transport hooks (`ack`/`terminalize`/
`authorize`/`resolveContext`); providers supply only HTTP + markup. Import
`samePermissionClaim` instead of the four re-coded scope-equality helpers.

### A2 · MED — second `JSON.stringify`-identity comparison of the recovery envelope
`apps/core/src/application/interactions/pending-interaction-permission-callback.ts:122-123`
groups review-each batch rows by
`JSON.stringify(interaction.payload.permissionRecoveryEnvelope) === JSON.stringify(envelope)`.
`readPermissionRecoveryEnvelope` (`pending-interaction-permission-envelope.ts:106`)
returns the object un-reconstructed, so both operands are raw jsonb copies.
Same order-sensitive desync as the audited `sharedPermissionRecoveryEnvelope`
line-120 comparison.

**Failure mode:** if one row's envelope round-trips through jsonb with a
different key order, review-each rows fail to group → some batch members never
get their persisted decision dispatched → that permission silently sticks.

**Target shape:** group by a stable id already on every member —
`envelope.batch.canonicalId`, or the sorted set of member `requestId`s.
Retro-applies to the line-120 comparison.

### A3 · LOW — review-prompt dedup `Set`s (new copies of the `reviewEachReplays` shape)
- `apps/core/src/jobs/ipc-admin-handlers.ts:89` `pendingRequestOnlyCapabilityReviews` (used 318-319, 639)
- `apps/core/src/jobs/ipc-skill-install-handlers.ts:38-39` `pendingSkillInstallCommandReviews`/`pendingSkillPackageReviews` (used 158-165, 395-402; cleared 330/420/471/475)

Process-local, lost on restart, blind across processes → a duplicate approval
prompt can surface. The durable pending-review record is the real guard, so
this is prompt-dup/UX, not double-install.

**Target shape:** unique partial index `(scope, review_key) WHERE status='pending'`
on the durable pending-review/interaction table; dedup off that row.

### Carried from the original 10-smell audit (same subsystem)
- **#1 HIGH — claim state machine as jsonb key presence/absence:**
  `apps/core/src/adapters/storage/postgres/repositories/worker-coordination-interaction.postgres.ts`
  (`claimPendingPermissionCallbackRows:240-392` deletes/re-adds
  `permissionCallbackId`/`permissionBatchCallbackId` and inserts
  `permissionCallbackClaim`, guarded by `NOT (payload ? 'permissionCallbackClaim')`;
  `releasePendingPermissionCallbackRows:394-425` reconstructs the deleted keys
  from the claim; `createPendingInteractionRow:84-115`; `resolvePendingInteractionRow:158-181`).
  **Target:** real columns (`claim_id`, `claim_source_agent_folder`, `claim_kind`,
  `claim_mode`, `claimed_at`) or a `permission_claims` table with
  `UNIQUE (app_id, source_agent_folder, interaction_id)`; single-winner becomes
  `UPDATE … WHERE claim_id IS NULL` or `INSERT … ON CONFLICT DO NOTHING RETURNING id`;
  release = `SET claim_id=NULL` / `DELETE` (no reconstruction).
- **#2 HIGH — recovery envelope duplicated into every batch row:**
  `pending-interaction-prompt-binding.ts:199-233` +
  `pending-interaction-permission-envelope.ts:109-139` (`sharedPermissionRecoveryEnvelope`
  requires N `JSON.stringify`-identical copies). **Target:** store the envelope
  once (canonical row / separate table); members carry `{envelopeId, index}`.
- **#4 MED-HIGH — `reviewEachReplays` process-local promise-memo:**
  `pending-interaction-permission-callback.ts` `replayPersistedReviewEach:151-234`.
  Same class as A3; folds into the same durable-index fix.
- **#5 LOW — blind double-resolve retry:**
  `apps/core/src/application/interactions/durable-interaction-handler.ts:74`. Make
  the retry conditional on the current envelope state.

---

## Group B1 · MED-HIGH — Jobs `target_json` recovery-intent (independent subsystem)

The genuine sibling of the permission jsonb disease, in the jobs layer. The job
recovery state machine (+ failure counter, pause reason, setup/notify-dedup
flags) lives as nested keys in an unconstrained jsonb blob, mutated by an
**unlocked full-document read-modify-write**:
- Schema: `apps/core/src/adapters/storage/postgres/schema/jobs.ts:43` (`target_json jsonb`, no column/CHECK/unique for the coordination fields).
- Writer: `canonical-job-ops-service.ts:486-500`, `:514-543`. Readers (2nd copy, return `undefined` on any unrecognized shape): `canonical-job-target-state.ts:48-104` (`parseRecoveryIntent`), `:3-35` (`parseSetupState`).
- Claim guard reads `target.recoveryIntent?.state === 'running'`: `canonical-job-claim.postgres.ts:41-48`; also `application/jobs/job-permission-recovery.ts:67`, `application/jobs/job-recovery-intent-service.ts:42,78,92-119,100-101`.
- Mutation: `job-recovery-intent-service.ts:92-119` → `canonical-job-ops-service.ts:100-111` `updateJob` (unlocked `getJobById` → JS spread-merge → rebuild whole blob) → `canonical-job-repository.postgres.ts:290` full-replace `WHERE id=?`, no CAS.

**Failure modes:** (1) lost update — concurrent `updateJob`s overwrite the whole
blob; a failure-counter bump or recovery transition silently vanishes, so a job
that should pause after N failures under-counts and never trips. (2) shape-drift
→ `parseRecoveryIntent` returns `undefined` → a parked job becomes
**re-claimable** (the exact double-trigger recovery prevents). (3) `dedupe_key`
has no unique index — idempotency is a TS string-compare on a stale read →
duplicate recovery notifications.

**Target shape:** promote coordination fields to real columns (`recovery_state`,
`recovery_dedupe_key`, `recovery_attempts`, `consecutive_failures`) + partial
unique index (`WHERE recovery_state IN ('pending','running')` or unique on
`recovery_dedupe_key`); transitions as atomic CAS
`UPDATE … SET recovery_state=$new, recovery_attempts=recovery_attempts+1 WHERE id=$id AND recovery_state=$expected`,
or route through the existing `FOR UPDATE` claim transaction. Leave genuinely
opaque parts (`executionContext`, `notificationRoutes`, `accessRequirements`) in
jsonb. Related to the durable-work-primitive cycle (fable review #1) but cleanly
separable.

---

## Group B2 + low — Coordination hardening (batch)

- **MED — `apps/core/src/shared/skill-install-lock.ts:7`** — an in-process `Map`
  mutex is the *only* serialization for durable skill file writes + rollback; a
  shared S3 skill-artifact store exists, so two hosts installing the same key
  interleave check-then-write and clobber each other. Self-documented as a
  follow-up. **Target:** `pg_advisory_xact_lock(hashtextextended(key,0))` (pattern
  at `worker-coordination-lease.postgres.ts:42`, `file-artifact-repository.postgres.ts:349`),
  or a version column + guarded `UPDATE`/`ON CONFLICT` on the skill artifact row.
- **LOW-MED — `apps/core/src/session/session-compaction-command.ts:27`
  `queuedCompactions` Set** (65,68,77,217) — per-process dedup only load-bearing
  when the durable `admitSessionCompactionTask` port is not wired. **Target:**
  always route through the durable (advisory-locked) admit path; delete the Set.
- **LOW — `apps/core/src/jobs/async-task-admission.ts:34-50`
  `createTaskWithLocalAdmission`** — lock-free count-then-insert (TOCTOU) that
  overshoots the backlog cap. It is a *fallback*; the Postgres repo already
  implements `createTaskWithBacklogAdmission` with `pg_advisory_xact_lock`
  (`async-task-repository.postgres.ts:44-77`). **Target:** delete the fallback /
  mark test-only; require the advisory-locked method.
- **LOW — two "canonical JSON" serializers in `shared/`** —
  `apps/core/src/shared/canonical-json.ts` (`canonicalJson`, drops `undefined`
  keys) vs `apps/core/src/shared/stable-hash.ts` (`canonicalize`/`stableSha256Json`,
  keeps the key).
  Cleanly partitioned today (each subsystem uses one on both sign+verify), no
  active bug; pure future-drift risk. **Target:** one canonical serializer both
  subsystems import.
- **LOW — `apps/core/src/jobs/request-only-capability-dedupe.ts:14-22`** — dedup
  key is `JSON.stringify({…, toolInput})` over arbitrary nested agent input
  (order-sensitive → dedupe miss → duplicate prompt). **Target:** hash with the
  existing `stableSha256Json`, or dedup on a `requestId`.

### Carried from the original 10-smell audit (coordination family)
- **#10 — `apps/core/src/jobs/async-delegated-agent-task.ts`** — 3 hand-rolled
  CAS loops + a write-only steering ledger. Fold into the hardening batch or the
  durable-work primitive.
- **#6 — triplicated durable-rule/claim validators** (locate precisely at
  execution; related to `durable-access-policy.ts` satellites).
- **#7 — list-scan instead of an idempotency-key lookup** (locate at execution).
- **#8 — lease re-assertion repeated ~5× on the write path** (locate at execution).

---

## Group C · MED — `desired-state-current-export.ts` hand-merge (original audit #9)

`apps/core/src/config/settings/desired-state-current-export.ts` — ~650-line
hand-merge that silently strips unknown fields. Its own goal (config/settings
surface), separable from the coordination work. **Target:** a schema-driven
merge/round-trip that fails loud on unknown fields (mirror the strict parser
convention used elsewhere in `config/settings`).

---

## Verified CLEAN — do not re-audit

State machines done right (real `status`/`state` column + DB-enforced
single-winner): `run_leases` (partial unique on `status='active'` + fencing),
`live_turns`, `live_admission_work_items`, `outbound_delivery_items`/`outbound_deliveries`,
`webhook_deliveries`, `agent_async_tasks` (status + lease_token), `canonical_jobs`
claim itself (status + leaseRunId + `FOR UPDATE`), `runtime_dependencies`,
`settings_revisions`, `pattern_candidates`, `external_ingress_invocations`,
`worker_instances`. Legitimate opaque jsonb (not a state machine):
`memory_items.source_ref_json`, `runtime_events.payload_json`, worker
`grant_json`, brain `op_json`, session `metadata_json`, job `executionContext`/
`notificationRoutes`. Legitimate in-memory memos (rebuild correctly / durable
backing): `activeCompactReceipts`, `notifiedConversations`, `credentialBindingPromises`,
live OS-process/MCP/browser handle maps, `memory/maintenance-queue` inflight sets.

Minor hardening note (not the disease): most `status`/`state` columns document
allowed values in a code comment, not a DB `CHECK`/enum. Adding CHECK constraints
would harden them but they are already real, indexable, atomically-updatable.
