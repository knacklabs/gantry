---
slug: model-governance
title: Model governance: per-agent model allowlist and pre-model guardrails
status: draft
saved: 2026-08-27T07:38:53+00:00
---


# Model governance: per-agent model allowlist and pre-model guardrails

## Capability

An administrator decides which models each AI employee may call, and the gateway
enforces it; and everything that leaves for a model passes one guardrail hook
that redacts personal data and secrets by default and accepts stronger external
guardrails. Gantry stays the runtime, not a gateway: an organisation that already
runs LiteLLM or another gateway points the `openai_compatible` provider at it and
inherits its budgets and guardrails.

## Why

"Only the access they need" includes which models. A sovereign buyer's first
question is whether the finance agent can ever reach a public provider; today the
model is a default, not a boundary. The second question is DLP. Both are answered
here narrowly, without rebuilding an AI gateway.

## Behaviour

### Model allowlist (V1.0.x)

Each agent carries an allowlist of model aliases; an empty list means the
deployment default set. The gateway refuses any call outside the list with a
named, audited denial, on every model-call path (runs, direct LLM API on behalf
of the agent, memory extraction, dreaming). The allowlist is visible in the
Access tab and editable in the access editor; the sovereign quickstart shows an
on-prem-only agent.

### Guardrail hook (V1.0.x)

One pre-model hook on every model-call path with a stable interface: a guardrail
may redact, block, or annotate; each trigger is audited with agent, conversation,
rule, and outcome, never the redacted content. One in-repo guardrail ships —
PII patterns (email, phone, configurable national ids) and secret patterns
(keys, tokens) — with a reversible mapping held in-process for the turn only.
External guardrails (LiteLLM, Lakera, Presidio) attach through the same hook.
Prompt-injection classification is explicitly not built in-repo.

### Not in scope

Semantic caching, cross-key load balancing, virtual keys as a product, and a
general gateway. Rate limits live with the hard cost cap (COST-2).

## Acceptance criteria

- **MODEL-1** — Per-agent model allowlist enforced at the gateway
  - Agent config carries an allowlist of model aliases; the model gateway refuses any call outside it with a named, audited denial; empty allowlist means the deployment default set
  - Enforced for every model-call path (runs, direct LLM API on behalf of the agent, memory extraction, dreaming) — same coverage list as COST-2
  - Allowlist appears read-only in the Access tab (DIR-UI-1) and editable in ACCESS-UI-1; sovereign quickstart shows an on-prem-only agent
- **GUARD-1** — Pre-model guardrail hook with built-in PII and secret redaction
  - One pre-model hook point on every model-call path with a stable interface; hooks can redact, block, or annotate; every trigger audited with agent, conversation, rule, and outcome (never the redacted content)
  - One in-repo guardrail ships: PII patterns (email, phone, national ids configurable per deployment) and secret patterns (keys, tokens) redacted before the request; reversible mapping kept in-process for the turn only
  - External guardrails (LiteLLM, Lakera, Presidio) attach through the same hook; prompt-injection classification is explicitly not built in-repo
  - Indian PII patterns (Aadhaar, PAN, IN phone) default-on for deployments in India; per-deployment pattern set configurable

## Source

LiteLLM comparison and enterprise-data grill, 2026-08-26. Stories: MODEL-1, GUARD-1.
