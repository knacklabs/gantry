---
issue: WEB-CONSOLE-3
title: Web Runtime Console: Phase 3 bounded metrics
status: approved
saved: 2026-08-12T16:27:56+00:00
story: WEB-CONSOLE-3
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
  - 0104-co-1-recovery-intent-reframe
  - 0105-physical-attachment-workspace-handoff
  - 0106-scheduled-runs-cannot-mutate-jobs
  - 0107-typed-permission-decision-provenance
  - 0108-job-definition-revision-fencing
  - 0109-semantic-capability-job-dependencies
  - 0110-live-ux-capability-dispatcher
  - 0112-legacy-single-canonical-shape
  - 0113-enforce-no-backcompat-architecture-check
  - 0114-canonical-job-owner
  - 0115-autonomous-tool-denial-terminal
  - 0117-scheduled-job-declare-tools-at-creation
  - 0118-identity-scoped-approval-and-grants
  - 0119-provider-neutral-group-approver-bootstrap
  - 0120-local-cli-structured-invocation
  - 0121-autodet-no-classifier-autonomous
  - 0122-capability-template-amendment
  - 0123-recovery-proposal-birthright
  - 0124-web-runtime-console-read-only-integration
---

# WEB-CONSOLE-2 — Read-only operations

# WEB-CONSOLE-3 — Bounded metrics

## Problem

Phase 2 exposes the serving deployment, instances, and safe agent inventory,
but it does not explain workload, model usage, or cost over time. Operators
need a small, reliable 30-day view that uses Gantry’s existing durable runtime
truth without imposing an unbounded query or a second telemetry system.

## Scope / Non-goals

Deliver a Metrics screen with Overview, Usage, and Runtime tabs; fixed 24-hour,
7-day, and 30-day UTC aggregates; a safe Control API projection; a five-minute
same-process UI-API cache with in-flight request deduplication; and a bounded
30-day Runtime Event Exchange retention sweep.

Do not add authentication/roles, mutations, arbitrary timestamps or bucket
sizes, raw event payloads, Prometheus scraping, OpenTelemetry persistence,
provider/model-call latency, Redis, a telemetry store, background browser
polling below five minutes, agent restart controls, Phase 4 activity/SSE, or
frontend unit/component/browser-automation/snapshot tests.

## Acceptance Criteria

1. Metrics offers exactly 24h, 7d, and 30d server-owned UTC ranges with 24h as
   default. Each response has bounded point and series counts; seeded usage
   events and completed agent runs produce matching aggregates.
2. The UI presents request/token/cache/cost totals, bounded model mix,
   run-volume/status distribution, and p95 explicitly labelled “End-to-end
   agent run duration”. Missing optional values render “Unavailable”, never
   zero or model-call latency.
3. The browser receives only safe same-origin UI API projections. Identical
   metrics requests are cached for five minutes and share one concurrent
   upstream fetch; manual refresh is deduplicated.
4. Runtime-event cleanup preserves every event whose timestamp is at or newer
   than the 30-day cutoff and skips any older event with a pending or
   in-progress event-bus outbox or webhook-delivery row. Each scheduler pass is
   lock-protected and batch-bounded.
5. Focused Control API, repository, retention, and UI-server cache tests pass;
   manual browser validation covers populated, unavailable, loading, stale,
   disconnected, keyboard, reduced-motion, and light/dark states. No frontend
   test suite is added.

## Technical Approach

1. Extend the existing RuntimeEventRepository usage projection and GET /v1/usage
   contract rather than add an event reader or metrics store. A new fixed-range
   metrics projection may call the repository for totals, UTC buckets, and
   top-model rows. It caps bucket count and model series server-side; all other
   rows roll into one Other series. Existing agent_runs is queried only for
   completed runs with start/end timestamps, yielding count/status and
   percentile_cont(0.95) duration in a bounded interval. The UI calls this
   duration “End-to-end agent run duration”.
2. Add a small authenticated Control API metrics endpoint (requiring usage:read)
   plus contracts/OpenAPI/SDK support. It accepts only range (24h, 7d, 30d) and
   an optional safe grouping/tab selector if the existing usage endpoint cannot
   express the fixed screen projection; it rejects arbitrary dates. The old
   GET /v1/usage remains its general usage API, while the new endpoint is
   purpose-built for the console.
3. Extend the existing UI server with /ui/api/metrics/usage and
   /ui/api/metrics/runtime. A single tiny in-memory Map cache helper in the UI
   server keys by pathname and normalized query. It stores a successful safe
   projection for five minutes and its one in-flight promise only; failed
   fetches are not cached. Cache storage remains per-process and bounds entries
   to the small fixed route/range set.
4. Add a production Metrics route, navigation entry, and three read-only tabs.
   Reuse existing RouteTabs, MetricTile, Panel, PageState, StatusBadge, chart
   primitives, and query failure/stale-data behavior. The 24h view is selected
   by default. Refresh occurs only while visible at five-minute cadence; manual
   refresh uses the same request key. No new UI dependency or animation system
   is introduced.
5. Add deleteExpiredRuntimeEvents to the runtime-event repository. Reuse the
   existing scheduler-maintenance retention pattern: a six-hour due guard,
   advisory transaction lock, and a fixed number of FOR UPDATE SKIP LOCKED
   batches. Candidate rows are older than the cutoff and have no pending or
   in-progress event_bus_outbox or control_http_webhook_deliveries record.
   Delete only candidate IDs, so FK cascades cannot erase delivery evidence.
   A failed/partial sweep is retried by the next maintenance sync and never
   aborts scheduling.

The simpler alternative—letting the browser choose an arbitrary /v1/usage date
range and periodically deleting runtime_events by timestamp—is rejected: it
would create unbounded database work and let FK cascades discard undelivered
outbox/webhook evidence. The existing bounded repository and scheduler
maintenance paths are the smaller safe shape.

## Decisions

- [0013-runtime-event-exchange.md](../../docs/decisions/0013-runtime-event-exchange.md)
  makes runtime_events the retention owner and requires an operator-owned
  cleanup path.
- [0015-model-catalog-and-cache-accounting.md](../../docs/decisions/0015-model-catalog-and-cache-accounting.md)
  governs model/cache accounting. Metrics returns recorded normalized values;
  it does not invent provider latency.
- [0103-live-admission-terminal-retention.md](../../docs/decisions/0103-live-admission-terminal-retention.md)
  establishes existing scheduler-maintenance retention as the reuse point.
- [0124-web-runtime-console-read-only-integration.md](../../docs/decisions/0124-web-runtime-console-read-only-integration.md)
  governs the server-held Control API credential and browser-safe UI API
  boundary.
- No new decision: server-owned fixed ranges, a local TTL cache, and
  scheduler-owned bounded cleanup are consequences of the confirmed Phase 3
  spec and existing runtime-event/scheduler decisions.

## Surface Impact

| Surface | Status | Reason |
|---|---|---|
| Runtime behavior | Changed | Scheduler maintenance gains a bounded Runtime Event Exchange cleanup sweep. |
| settings.yaml | Unchanged by design | Range, cache duration, and retention are fixed product bounds, not operator-tunable settings. |
| Postgres/runtime projection | Changed | Existing runtime event and agent run truth gains bounded aggregation and deletion reads; no new table or migration is required. |
| Control API | Changed | Adds fixed-range metrics projection and extends typed usage fields. |
| SDK/contracts | Changed | New metrics schemas/SDK method preserve Control API contract parity. |
| CLI/ops | Read-only/observable | Existing scheduler maintenance owns cleanup; no manual CLI or deployment action is added. |
| Gantry MCP/admin tools | Unchanged by design | The console remains a passive observer; no agent/admin mutation is introduced. |
| Channel/provider adapters | Unchanged by design | Aggregation uses provider-neutral normalized runtime events and agent runs. |
| UI | Changed | Adds Metrics navigation, route, safe facade resources, and short-lived cache. |
| Docs/prompts | Changed | Records bounded metrics and retention ownership. |
| Audit/events | Changed | Runtime-event retention is the explicit event-exchange lifecycle policy; permission/audit stores remain untouched. |
| Tests/verification | Changed | Adds focused aggregation/cache/retention proof and manual browser acceptance; maintained UI tests remain excluded. |
| Live hierarchy/SSE | Deferred | Phase 4 owns execution trees and stream lifecycle. |
| Authentication/roles | Deferred | The approved private/local console keeps its existing server-held key boundary until deployment authentication work. |

## Task Decomposition

1. **WEB-CONSOLE-3.1 — Bounded metrics and retention projections.** Add the
   fixed-range Control API/contracts/SDK and repository aggregates, plus
   protected bounded retention wired into existing scheduler maintenance.
   Serves criteria 1, 2, and 4.
2. **WEB-CONSOLE-3.2 — Metrics console surface.** Add safe UI API cache and
   production Metrics route with Overview, Usage, and Runtime views. Serves
   criteria 1–3 and 5; depends on 3.1.

## Risks

- Usage event payloads can lack optional cache/cost fields. The projection
  preserves absence and UI labels it Unavailable; it must not coerce them to
  zero.
- runtime_events delete cascades to delivery rows. The eligibility predicate
  must block candidates referenced by pending/in-progress delivery work before
  deletion; terminal-delivery rows may delete with their event.
- agent_runs has no metrics-specific index. The fixed 30-day time range and
  completed-run predicate keep query work bounded; if explain evidence shows a
  scan is unacceptable, add the smallest dedicated app/time index in the same
  task rather than a caching system.
- The browser receives only facade projections. It cannot be trusted to
  enforce date/range/series limits or retention behavior.

## Verify Plan

- Run focused unit/API tests for fixed range rejection, safe response mapping,
  aggregate totals/buckets/model Other, missing values, p95 labeling, and
  UI-server cache/in-flight behavior.
- Run disposable Postgres integration tests for seeded aggregation,
  cutoff-boundary cleanup, pending/in-progress outbox and webhook protection,
  terminal delivery deletion, and bounded batches/lock behavior.
- Run contracts/SDK/web builds, format/lint/typecheck, database migration
  check if an index is required, and the deterministic factory verify command.
- Run one manual agent-browser pass against a configured local all runtime:
  24h/7d/30d tabs, populated/empty/unavailable/stale/disconnected states,
  five-minute refresh policy, keyboard navigation, reduced motion, and
  light/dark. Do not add a maintained UI test suite.
- Run one autoreview pass and one functional check before archive.

## Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-08-12: WEB-CONSOLE-3.1 exposes GET /v1/metrics with usage and runs in one response; 24h uses hourly UTC buckets, 7d and 30d use daily UTC buckets, and model mix returns up to five named models plus Other when needed.
