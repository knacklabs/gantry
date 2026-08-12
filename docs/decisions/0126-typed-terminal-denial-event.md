---
status: proposed
confirmed_by: ""
date: 2026-08-12
stories: [JOBFLOW-1]
---

# Typed Terminal Denial Event [JOBFLOW-1]

Amends 0115's scope wording (its ONLY exclusions are the Anthropic
model-validation, wait-only, and network guards; the protected-capability
and memory-boundary guards enter the terminal sweep, and DeepAgents
declarative-rule denials become terminal on scheduled runs). Reconciles
autonomous-jobs.md's overbroad "every denial is terminal" sentence.

## Context

Terminal-denial evidence travels as formatted marker strings parsed back
by finalization/status/visibility; the event is appended AFTER
finalization consumes the in-memory copy, and the emitter swallows append
failures — so the durable record can silently diverge from job state.

## Decision

The existing JOB_TOOL_DENIED runtime event is the single durable source
of terminal-denial truth, with an extended payload {denied_tool, reason,
denial_kind: permission_denied | rule_denied |
capability_template_mismatch, provenance {lane, seam}, and (until the
tagged-action cutover) the current recovery fields; after the cutover the
payload carries the typed action object}. The append is REQUIRED
(non-swallowing) and precedes finalization; an append failure converts to
a run error routed into finalization's existing retry branch. Runtime
events gain ONE nullable idempotency_key column with a partial unique on
(app_id, idempotency_key); conflicts skip all side effects (no outbox
envelope, no webhook) and read as already-recorded success. The lowest
persisted event_id per run is authoritative. Finalization, status
formatting, and visibility read the typed record through explicit seams;
the marker parser is deleted (helper isGrantableAutonomousToolRecovery
retained). Access-requirement preflight reroutes through setup readiness
(the assert-and-throw helper is deleted); there is no
access_requirement_missing denial kind.

## Consequences

- One denial format after the cutover; no dual reads (0112/0113).
- The idempotency column is a general primitive (delivery outcomes reuse
  it with their own namespaced keys).
- Rejected (do not re-propose): a second event type; lane-specific
  payload variants; co-transactional append with finalization; treating
  preflight access gaps as denials.
Full contracts: plans/JOBFLOW-contract-appendix.md (S2a).
