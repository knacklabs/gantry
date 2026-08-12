---
slug: web-runtime-console-phase-3
title: Web Runtime Console — Phase 3: Bounded Metrics
status: draft
saved: 2026-08-12T16:22:42+00:00
---

# Web Runtime Console — Phase 3: Bounded Metrics

## Why

The private console can now show the deployment and its agents, but it cannot
show the bounded cost and workload history needed to operate that deployment.
This phase adds that history without a second telemetry store, unbounded
queries, or a browser connection to Postgres.

## Behaviour

- The Metrics page remains a private, read-only `/ui` screen. It calls only
  same-origin UI API routes; the UI server retains the Control API credential.
- A server-owned range selector supports exactly **24h**, **7d**, and **30d**,
  defaulting to 24h. UTC bucket policy is fixed by the Control API. The browser
  cannot supply arbitrary timestamps, bucket widths, model limits, or raw SQL
  filters.
- The Control API extends the existing usage projection from `runtime_events`.
  It returns bounded request/token/cache/cost aggregates, UTC buckets, a
  top-model mix plus `Other`, run volume/status, and an explicitly-labelled
  **end-to-end agent run duration p95**. Missing optional signals are absent so
  the UI says `Unavailable`; they are never returned as zero.
- The UI API exposes a small safe projection and caches an identical metrics
  request for five minutes within the process. Concurrent identical requests
  share one fetch. It does not use Redis or another shared cache.
- An operator-owned runtime cleanup removes only a fixed-size batch of
  `runtime_events` older than 30 days when they have no pending/in-progress
  event-bus outbox or webhook-delivery reference. The batch preserves events
  at the 30-day boundary and all pending-delivery evidence. No browser action
  triggers cleanup.

## Acceptance criteria

1. Metrics supports exactly 24h, 7d, and 30d UTC ranges, bounded response
   points, and a 24h default; aggregate values match seeded usage events and
   completed agent runs.
2. Request, token, cache, recorded cost, model mix, run-volume/status, and
   end-to-end run-duration p95 are clearly projected. Missing optional data is
   `Unavailable`, never fabricated zero or model-call latency.
3. UI API responses are browser-safe, cached for five minutes per identical
   query, and deduplicate concurrent upstream reads without a new dependency.
4. Runtime-event retention preserves events newer than or exactly 30 days old
   and never cascades away pending/in-progress outbox or webhook-delivery
   evidence; each cleanup invocation is batch-bounded and operator-owned.
5. Focused backend/API/cache/retention tests protect the new contracts. No
   frontend unit, component, browser automation, snapshot, or visual-regression
   suite is added; the page receives manual browser validation instead.

## Non-goals

- Authentication, roles, metrics mutations, Prometheus scraping, a new
  telemetry database, provider/model-call latency, raw runtime-event payloads,
  arbitrary date ranges, Redis, live activity/SSE, and agent restart controls.
