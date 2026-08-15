---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-09
stories: [PREFLIGHT-1, JOBFLOW-1]
---

# Scheduled Jobs Declare Their Tool Requirements at Creation

## Context

A scheduled job runs as its agent and inherits the agent's host-reviewed granted tools,
but nothing captures the tools the *task* will need. `access_requirements` is optional and
usually omitted, so creation-time readiness passes even when the task will need a tool the
agent lacks; the gap surfaces only when a scheduled run hits the tool and pauses. We want
gaps surfaced at creation, and the pause card to be actionable — without the worker/agent
self-granting (PERM-2) and identically across the DeepAgents and Anthropic-SDK lanes.

Prime-based auto-discovery (a no-execute pass at creation) was evaluated and **rejected**:
it is Anthropic-lane-only (the DeepAgents runner has no record-without-execute mode, so a
`runMode:'prime'` spawn there would execute tools for real at creation and abort on the
first denial), it is only half-wired to the host (the runner records attempts but the host
`AgentOutput` never receives them), and it duplicates the dead `JobPrimingService` plus the
existing `normalizeAccessRequirements` then `evaluateJobReadiness` pipeline (violating the
single-canonical-shape rule, 0112/0113).

## Decision

The creating agent **declares** the tools a scheduled job will need at creation, populating
`access_requirements` on the existing `scheduler_upsert_job` argument, preferring semantic-
capability IDs (0109). The existing readiness check compares the declaration against the
agent's grants; when a declared tool is missing, creation surfaces **one** actionable
setup card, **dispatched asynchronously** so job creation stays fast and silent. Grant is
a human-initiated action via that card; the worker never self-grants. The runtime pause
(`pauseJobForSetupIfNeeded`) remains the fallback for tools the agent under-declares and
for checks that can only run at run time (worker image, browser launch, fleet).

Prime-based auto-discovery is rejected (see Context) and must not be reintroduced unless a
neutral DeepAgents record-without-execute mode is first built.

Decisions 0124 and 0128 supersede this record's best-effort setup-card delivery clause
and any treatment of delivery failure as a human decision.
Setup-card preparation is atomic and delivery is durable and bounded to four attempts,
with an explicit delivered, ambiguous, exhausted, expired, or cancelled outcome and a
defined owner recovery for each. Delivery failure is never recorded as a human denial.

Making builtin facade tools grantable on the setup card is **not a new architectural
choice** — it reconciles `autonomousGrantRecovery` with the durable-access policy, which
already accepts exact facade tool rules, and with existing operating guidance that already
instructs `request_access target.kind=tool` for exact facades. It carries no separate
decision.

## Consequences

- Jobs whose declared tools the agent already has are `ready` and never pause. Jobs needing
  an ungranted tool surface it once, at creation, as an actionable card.
- Setup-card preparation and outbound delivery follow decision 0124: one atomic durable
  preparation, generation-aware idempotency, at most four attempts, and defined recovery
  for delivered, ambiguous, exhausted, expired, and cancelled outcomes. Lost or duplicate
  cards are no longer an accepted best-effort consequence.
- Neutral across both lanes (declaration + shared compiled prompt + shared recovery/card
  path); no `runMode`/prime code is added; no application-to-runtime layer violation (the
  creation notification crosses via an application-owned port wired in runtime composition).
- PERM-2 preserved: declaration is not authority; durable grants are written only after a
  user-permanent host decision.
- The dead `JobPrimingService` is left as separate cleanup; declaration completeness is
  best-effort (agent prediction), with the runtime button/pause as the documented fallback.
