---
issue: CO-1
title: Jobs recovery-intent as columns with compare-and-set transitions
status: approved
saved: 2026-08-03T08:35:32+00:00
story: CO-1
decisions_reviewed:
  - 0000-credential-broker-boundary
  - 0001-agent-runtime-platform
  - 0002-symphony-forge-adoption
  - 0003-early-stage-no-backcompat
  - 0004-gantry-naming-and-public-repo
  - 0005-runtime-stack
  - 0006-config-secret-source-boundary
  - 0007-settings-runtime-truth
  - 0008-storage-backend-cutover
  - 0009-canonical-domain-schema-cutover
  - 0010-claude-runtime-materialization
  - 0011-provider-session-artifact-store
  - 0012-browser-capability-boundary
  - 0013-runtime-event-exchange
  - 0014-external-ingress-vs-outbound-webhooks
  - 0015-model-catalog-and-cache-accounting
  - 0016-event-bus-outbox-boundary
  - 0017-jsonb-runtime-payload-boundary
  - 0018-provider-neutral-agent-execution-adapter
  - 0019-simple-permission-and-job-tool-lifecycle
  - 0020-mcp-source-vs-action-capability
  - 0021-capability-artifacts
  - 0022-delivery-vehicle
  - 0023-deployment-modes
  - 0024-locked-preset
  - 0025-settings-authority
  - 0027-process-roles-and-multi-live
  - 0028-agent-harness-selection
  - 0029-agent-communication-reaction-binding
  - 0030-agent-communication-reasoning-safety
  - 0031-send-message-files-authority
  - 0032-signed-artifact-links-deferred
  - 0033-teams-reactions-deferred
  - 0034-client-signoff
  - 0035-epics-approved
  - 0040-permission-execution-two-axis-model
  - 0041-client-signoff
  - 0042-decision-view-16k-prefix-stripped
  - 0043-classifier-risk-only-engine-authz
  - 0044-ci-runner-isolation
  - 0045-inbound-attachment-descriptor-writer
  - 0046-llm-process-local-admission
  - 0050-agent-removal-projection-cleanup
  - 0051-client-signoff
  - 0052-birthright-self-surface
  - 0053-permission-no-timeout-interactive
  - 0054-decision-provenance-and-risk-label
  - 0055-client-signoff
  - 0056-durable-cancellation-invariant
  - 0057-arch1-client-signoff
  - 0058-readonly-scheduler-birthright
  - 0062-perm6-client-signoff
  - 0063-perm7-client-signoff
  - 0064-client-signoff
  - 0065-perm8-client-signoff
  - 0066-race-1-skill-artifact-app-isolation
  - 0067-client-signoff
  - 0068-race-2-cluster-fenced-settings-projection
  - 0069-client-signoff
  - 0070-client-signoff
  - 0071-race-4-browser-profile-lock-aba
  - 0072-client-signoff
  - 0073-race-6-profile-mirror-version-guard
  - 0074-race-8-mandatory-atomic-async-admission
  - 0075-race-9-serialize-file-backed-settings-write
  - 0076-client-signoff
  - 0077-race-5-lease-loss-lifecycle
  - 0078-lat-3a-single-memory-hydration-per-turn
  - 0079-client-signoff
  - 0080-lat-3b-retain-authoritative-second-fetch
  - 0081-client-signoff
  - 0082-fence-1-durable-lease-generation
  - 0083-conv-001-client-signoff
  - 0084-client-signoff
  - 0085-lat-4a-fused-inbound-envelope-transaction
  - 0086-client-signoff
  - 0087-lat-5-durable-provider-history-coverage
  - 0088-client-signoff
  - 0089-thread-turns-read-channel-context
  - 0090-sender-allowlist-trigger-only
  - 0091-client-signoff
  - 0092-client-signoff
  - 0093-client-signoff-is-a-pinned-project-gate
  - 0094-conversation-file-trust-program
  - 0095-client-signoff
  - 0096-thread-recency-message-timestamp
  - 0097-public-session-conversation-aggregate
  - 0098-streamed-message-projection-timing
  - 0099-rate-limits-singleton-authority
  - 0100-mig-1-client-signoff
  - 0101-oidc-generic-google-first
  - 0102-runtime-hardening-audit-harvest
  - 0103-live-admission-terminal-retention
---


# CO-1 — Job coordination state: delete the dead recovery-intent machine, make the live fields race-safe

## Objective

Audit item B1 flagged the job coordination state living as nested keys in the
unconstrained `target_json` blob, mutated by unlocked full-document
read-modify-write. Verification against today's main found the headline target —
the recovery-intent state machine — has ZERO production callers (nothing ever
writes a non-null intent; the claim guard is always false), while three sibling
fields ARE live and genuinely lost-update-prone: `consecutiveFailures` (drives
auto-pause), `pauseReason`, and `setupState` (incl. the notify-dedup
fingerprint). Ravi decided 2026-08-03: delete the dead machinery outright and
promote the live fields to dedicated columns with targeted, race-safe writes.

## Context (verified 2026-08-03, main @ 69ac5b716)

- Blob write: `canonical-job-ops-service.ts:493-507` (`toRecordInput`); read
  `:412-468` (`rowToJob`); unlocked RMW `updateJob` `:100-111`; repo
  full-replace `canonical-job-repository.postgres.ts:289-306`.
- DEAD (delete): `job-recovery-intent-service.ts` (create/transition — only
  callers are its own unit test), `parseRecoveryIntent`
  (`canonical-job-target-state.ts:48-104`), `JobRecoveryIntent` type
  (`domain/job-types.ts:107-120`), claim-guard read
  (`canonical-job-claim.postgres.ts:41-48`, always false in prod), skip-check
  `job-permission-recovery.ts:67`, `recoveryMetadataForJob`
  (`job-visibility-metadata.ts:435-446`) and its payload surfacing, the three
  null-clear writes, and the type-only `JobRecoveryIntentSource` import in
  `execution-readiness.ts:9`.
- LIVE (promote to columns): `consecutiveFailures`, `maxConsecutiveFailures`,
  `pauseReason` (scalars) and `setupState` (object incl. `blockers[]` and
  `notified_fingerprint`). Writers: pause-for-setup
  (`execution-readiness.ts:127-134`), notify-dedup (`:162-170` — full-blob RMW
  racing the former), permission-recovery clear/rewrite
  (`job-permission-recovery.ts:90-111`), readiness clears
  (`job-management-readiness.ts:52`, `job-management-run-now.ts:98-106`),
  failure bookkeeping (`execution-lease.ts:202-213` → repo `:512-537`, ALREADY
  lease-CAS + jsonb merge — the good path to generalize).
- Non-coordination blob fields stay put: `executionContext` (4 expression
  indexes + raw SQL joins), `notificationRoutes`, `accessRequirements`,
  `requiredCapabilities`, `createdBy`, `cleanupAfterMs`.
- Migrations are timestamp-prefixed via
  `npm run db:migrations:generate -- --name <desc>` (+ journal/snapshot emitted;
  never hand-edit `_journal.json`); backfill/strip template =
  `0061_jobs_tool_access_requirements_cutover.sql`;
  `postgres-migration-journal.test.ts` pins literal SQL of notable migrations
  and the 103-table baseline (columns fine, new tables not).
- Raw-SQL allowlist: a Drizzle `.update().where()` CAS needs no entry;
  `.execute(sql`, advisory locks in `canonical-job-*.postgres.ts` do
  (`postgres-raw-sql-allowlist.test.ts:8-39`).

## Approach

### 1. Delete the dead recovery-intent machinery (no legacy)

Remove the service, parser, domain type, claim-guard read, skip-check,
visibility metadata field, null-clear writes, and the unit test. Data hygiene:
the cutover migration strips `recovery_intent`/`recoveryIntent` keys from
`target_json` (all-null in prod; precondition block RAISEs if any non-null
intent exists, so the migration refuses rather than silently deleting real
state).

### 2. Columns for the live fields

New jobs columns: `consecutive_failures int NOT NULL DEFAULT 0`,
`max_consecutive_failures int` (nullable, as today), `pause_reason text`,
`setup_state jsonb`. One cutover migration: add columns → backfill from the
blob (both key spellings) → strip those keys from `target_json` → precondition
+ literal-SQL journal-test assertions per the 0061 template.

### 3. Race-safe writes (the point of the story)

- Counter: in-DB arithmetic (`SET consecutive_failures = consecutive_failures
  + 1`) inside the existing lease-guarded finalization — concurrent increments
  both count; no read-modify-write anywhere.
- `setup_state`: single-statement targeted UPDATEs; the notify-dedup write
  becomes `jsonb_set(setup_state, '{notified_fingerprint}', …)` guarded by
  `WHERE setup_state->>'fingerprint' = <expected>` so it can neither clobber a
  concurrent pause-rewrite nor mark the wrong fingerprint notified.
- `pause_reason`/clears: plain column sets in the same targeted statements —
  no blob rebuild can lose them, because they are no longer in the blob.
- `updateJob`/`toRecordInput`/`rowToJob` stop knowing these fields exist in
  the blob; the Job domain shape keeps the same field names, now sourced from
  columns. No compatibility shims: blob keys gone, unknown-shape reads fail
  loudly in tests.

## Verification

```bash
npm run typecheck
npm run db:migrations:check
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/adapters/storage/postgres apps/core/test/unit/application apps/core/test/unit/storage/postgres-migration-journal.test.ts
GANTRY_TEST_DATABASE_URL=... npm run test:integration:postgres
python3 factory/scripts/verify.py
```

Behavioral checks that must exist:
1. Concurrent-writers integration test (copy
   `pattern-candidate-atomic-claim.postgres.integration.test.ts` shape): a
   notify-dedup write racing a pause-rewrite loses neither field; parallel
   failure-counter increments both land (count == 2).
2. Migration backfill: seeded blob rows (both key spellings, plus a row with
   neither) come out with correct column values and stripped blobs.
3. Fingerprint guard: a notify-dedup write against a changed setup fingerprint
   is a no-op.
4. Grep-clean: `recoveryIntent|recovery_intent` appears nowhere in src/ or
   test/ (except the unrelated `pending_access_requests.target_json`).
5. Existing job lifecycle/claim/visibility suites pass with the field removed
   from payloads (no-backward-compat: consumers of the removed metadata field
   are updated, not shimmed).

## Risks

- The jobs table hasn't gained a column since the pre-timestamp migration era —
  the 0061/0071 cutover template plus `db:migrations:check` covers the shape;
  drizzle TAIL snapshot regen after any main merge (known gotcha).
- `setup_state` blockers array stays one jsonb value — writers replace it
  wholesale ONLY in statements that also own the fingerprint, which is the
  existing semantic.
- Visibility payload loses the never-populated recovery metadata field; SDK
  grep confirmed no external consumer.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | lost-update races on failure counter / pause / setup state become impossible; dead guard removed |
| Data/schema | Changed | 4 new jobs columns; cutover migration backfills and strips blob keys |
| API | Changed | job status/listing payloads drop the always-empty recovery metadata field |
| CLI/ops | Unchanged by design | none read the removed field |
| Docs | Changed | audit B1 marked superseded-by-reframe in the ledger via this story |
| Tests | Changed | concurrent-writer + migration-backfill + fingerprint-guard cases; dead-code test deleted |

`user_facing: false`.
