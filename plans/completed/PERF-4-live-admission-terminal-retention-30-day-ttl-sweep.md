---
issue: PERF-4
title: Live-admission terminal retention: 30-day TTL sweep
status: approved
saved: 2026-08-03T04:23:58+00:00
story: PERF-4
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


# PERF-4 — Live-admission terminal retention: 30-day TTL sweep

## Objective

Terminal live-admission work items (completed/failed/canceled) are never deleted, so
`live_admission_work_items` grows without bound. Decision 0103 fixed the policy: delete
terminal rows older than 30 days from the existing scheduled-maintenance machinery. This
story implements that sweep — one bounded task.

## Context (verified 2026-08-03)

- Table: `live_admission_work_items` (`schema/live-turns.ts:134-200`). State values
  `queued|claimed|deferred|completed|failed|canceled` — note `canceled`, one L
  (`domain/ports/live-turns.ts:243-247`). `ended_at` is set exactly at terminal settle
  (`live-admission-work-item-repository.postgres.ts:311-320`); use
  `coalesce(ended_at, updated_at)` defensively as the age column.
- Statements module: `live-admission-work-item-repository.postgres.ts` (add beside
  `settleLiveAdmissionWorkItem`, line 296); port `LiveAdmissionWorkItemRepository`
  (`domain/ports/live-turns.ts:197`); thin delegates on `PostgresLiveTurnRepository`
  (`live-turn-repository.postgres.ts:99-144`).
- Maintenance machinery: `PgBossSchedulerEngine.syncAllJobs()`
  (`scheduler-engine.ts:275`) runs every 60s AND on every requestSync; the existing
  sweep precedent is `sweepCompletedOneTimeJobs` (`jobs/cleanup.ts:12`). Scheduler
  already takes an injected live-admission dep (`hasLiveAdmissionBacklog`,
  `jobs/types.ts:36`, defaulted in `scheduler.ts:178-179`) — the sweep follows that
  exact shape. A REQUIRED new callback would break 26 fixtures in
  `task-scheduler-pgboss.test.ts`; the dep must be optional-with-default.
- Safety: no foreign keys; nothing reads terminal rows (all queries filter to
  non-terminal). One behavioral trade, intended per 0103: an idempotency-key redelivery
  arriving >30 days after settle re-enqueues instead of replaying.
- The shipped caps half counts only non-terminal states, so the sweep composes cleanly.

## Approach

1. **Statement**: `deleteExpiredTerminalLiveAdmissionWorkItems(executor, cutoffIso)` —
   one `DELETE ... WHERE state IN ('completed','failed','canceled') AND
   coalesce(ended_at, updated_at) < cutoff`, guarded by the same per-sweep
   `pg_advisory_xact_lock` pattern the enqueue cap uses (line 74) so concurrent
   scheduler processes cannot stampede; returns the deleted row count. Batched via
   `WHERE id IN (SELECT ... LIMIT 5000)` loop so the first-ever sweep on a large
   backlog cannot hold a long transaction.
2. **Port + delegate**: method on `LiveAdmissionWorkItemRepository`, delegate on
   `PostgresLiveTurnRepository`, exposed like its siblings.
3. **Cadence**: constant `LIVE_ADMISSION_TERMINAL_RETENTION_MS = 30 * 86_400_000` per
   decision 0103 (not configurable — the decision fixed it). The engine keeps a
   last-sweep timestamp and runs the sweep from `syncAllJobs` at most once per
   `LIVE_ADMISSION_RETENTION_SWEEP_INTERVAL_MS = 6h` per process; the advisory lock
   covers the multi-process overlap.
4. **No new index, deliberately**: every existing index is partial on non-terminal
   states, so the delete seq-scans. With 30-day retention the table is bounded and the
   sweep runs 4×/day — a seq scan at that cadence is cheap, and skipping the migration
   avoids drizzle-journal churn. Ceiling recorded: if the sweep ever shows up in slow
   logs, add a partial index on `(ended_at) WHERE state IN (terminal)`.
5. **Wiring**: optional injected dep `sweepTerminalLiveAdmissions` beside
   `hasLiveAdmissionBacklog` (`jobs/types.ts`), defaulted in `scheduler.ts` to the
   real statement — optional keeps the 26 existing scheduler fixtures untouched.

## Verification

```bash
npm run typecheck
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/task-scheduler-pgboss.test.ts
npm run test:integration:postgres   # live-admission-work-items suite carries the new case
python3 factory/scripts/verify.py
```

Behavioral checks that must exist:
1. Sweep deletes ONLY terminal rows older than the cutoff; keeps old non-terminal rows
   and recent terminal rows (integration,
   `live-admission-work-items.postgres.integration.test.ts`).
2. Cadence guard: within the interval, `syncAllJobs` does not invoke the sweep twice
   (unit, scheduler engine).
3. Existing capacity test ('replays duplicates at capacity and frees capacity only for
   terminal rows') stays green — the sweep must not run implicitly inside enqueue.

## Risks

- First sweep after deploy may delete a large backlog → batched deletes bound each
  transaction.
- Idempotency replay >30 days re-enqueues; intended trade per 0103, noted in the port
  method's doc comment.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | terminal rows now expire after 30 days |
| Data/schema | Unchanged by design | no migration; delete-only |
| API / CLI / UI | Unchanged by design | none read terminal rows |
| Docs | Unchanged by design | decision 0103 already records the policy |
| Tests | Changed | sweep integration case + cadence unit case |

`user_facing: false`.
