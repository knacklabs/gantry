---
status: accepted
confirmed_by: "vrknetha"
date: 2026-07-24
---

# LLM Process-Local Concurrency Admission

## Context

The 2026-07-24 audit found (High) that `/llm/v1/*` has no concurrency
admission: 120 near-16-MiB requests per minute can each hold multiple
body-sized buffers and a provider socket for up to ten minutes
(`apps/core/src/control/server/routes/llm.ts`, `gantry-model-gateway*.ts`). Separately, the
audit flagged that all rate limits are process-local while the control plane
supports horizontal scaling — an architecture decision scoped to SPS-4.

## Decision

Add a race-free concurrency permit gate (plain counter + single `finally`
release; no new dependency) in the LLM route, acquired BEFORE request-body
consumption: one global ceiling plus a per-app/key ceiling, settings-backed
with conservative defaults; excess requests get 429 without their bodies being
read. Admission is deliberately **process-local in this slice**; cluster-wide
authority (shared store vs singleton service) is deferred to SPS-4. The 16 MiB
body limit and 120/min rate limit are unchanged.

## Consequences

- Bounds simultaneous memory/socket occupancy per process; does not bound the
  cluster aggregate — documented, and revisited by SPS-4.
- `/llm/v1/*` gains a documented 429 concurrency-rejection mode; misconfigured
  low limits could throttle legitimate SDK use (settings override documented).
- Rejected: building the shared admission store now — that is the SPS-4
  architecture decision, not a blocker fix.
