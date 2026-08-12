---
status: proposed
confirmed_by: ""
date: 2026-08-12
stories: [JOBFLOW-1]
---

# Bounded Durable Card Delivery [JOBFLOW-1]

Amends 0117 (which explicitly accepted rare lost/duplicate setup cards as
best-effort, incl. echoes in docs/specs/preflight-1.md and
docs/architecture/autonomous-jobs.md). Owner confirmed the guarantee flip
in chat 2026-08-12.

## Context

The KnackLabs owner never received a working Allow/Deny card in
production: a failed provider send was recorded as a human denial, the
durable interaction row was resolved by the failure, and the fixed
per-job/fingerprint request id then read as already-pending forever.
Best-effort delivery permits exactly this silent-stall class.
`delivery-semantics` is a RECURRING x3 finding at jobs/execution-readiness.

## Decision

Setup approval cards are delivered through the outbound-delivery
subsystem with bounded retries (existing cap 4) and a DEFINED outcome for
every path: delivered, ambiguous, exhausted, expired, cancelled. The
setup-required event is published before delivery. Preparation (pending
interaction + permission prompt + full outbound aggregate) is one atomic
repository transaction; prompt identity is one row per issue with a
partial-unique across non-terminal lifecycle states on
(job_id, setup_fingerprint); the aggregate idempotency key is
generation-aware (`setup_permission_prompt:<promptId>:<generation>`).
A send-begun lease checkpoint separates retryable from ambiguous claim
expiry. Delivery outcomes are idempotent runtime events
(`job.setup_card_delivery`, one terminal outcome per generation); the
outbound item is the operational projection; `setup.deliveryNotice` is
the presentation seam. Ambiguous/exhausted never mutate the blocker or
its fingerprint; a card that did arrive stays live while its prompt is
open. A human's claim is never clobbered (claimed→superseded only for
authoritative target invalidation); recovered cards terminalize only
after full durable settlement. Job delete/cancel and prompt/delivery
cancellation are one transaction.

## Consequences

- The guarantee language is "bounded delivery with defined recovery",
  never "always a card": a crash after the send-begun checkpoint is
  conservatively ambiguous with a defined owner recovery.
- Schema: event idempotency column, prompt identity columns, outbound
  generation/checkpoint/cancelled columns + migrations.
- Prepared-send ports for ALL FOUR chat adapters (telegram-only would
  regress today's provider-neutral setup routing).
- Rejected (do not re-propose): prose fallback marking notified; a
  separate delivery state machine or projection table; a retrying event
  (attempt state lives on the item); a generation counter on prompt
  identity (new prompt row per issue instead; generation exists only on
  the delivery aggregate); suppressing delivery truth on stale jobs
  (events always append; only the job projection is CAS-conditional).
Full contracts: plans/JOBFLOW-contract-appendix.md (S3).
