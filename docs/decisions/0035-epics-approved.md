---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-22
---

# Epics Approved

## Context

First roadmap import under the harness, seeded from
`docs/architecture/goals-index.md` per DISCOVERY. Epics grill passed
2026-07-22 (2 questions; CAP-1 closeout exception and the exclusion list
confirmed by the client; digest-bound to the import JSON).

## Decision

The PM approves these ten epics for import (20 stories, all downstream of
PAY-1 per the client's "paydown first" directive; reconciled against merged
PRs 2026-07-22 at the client's request):

1. `harness-hygiene` — architecture gate paydown (PAY-1, first story)
2. `permission-engine` — git deterministic-gate slice, then the decision
   coordinator (PERM-1, PERM-2)
3. `observer` — land staged S2+S3a, then S3b/S4/S5 (OBS-1..4)
4. `agent-e2e-gate` — matrix reconcile, remaining rows, required-check flip
   (E2E-1..3)
5. `capability-search` — capability-authoring closeout (exception, no
   goal-prompt) + MCP hybrid search (CAP-1, CAP-2)
6. `ponytail` — Phase-8 offline cutover; Phases 1–7 in-lane + rescued WIP;
   executes only on the client's explicit go (PONY-1)
7. `observability` — OTel permission/decision spans completing #220/#262
   (OTEL-1, not started)
8. `post-cutover` — durable-work primitive + model management, depends_on
   PONY-1 (DUR-1, MDL-1)
9. `coordination-hardening` — audit items B1/B2/C (CO-1..3)
10. `artifact-store` — S3/MinIO bytes, low priority (ART-1)

Excluded from import (board-tracked with named gates): media-render,
Fable arch cycles #2–8, tenant isolation, KB ingestion, connector
strategy, Parked/Ideation items.

## Consequences

- `./forge roadmap import` proceeds against the grilled JSON; the initial
  parallel frontier is PAY-1 alone.
- Stories excluded here re-enter only via a fresh grill-bound import or
  `./forge roadmap add`.
