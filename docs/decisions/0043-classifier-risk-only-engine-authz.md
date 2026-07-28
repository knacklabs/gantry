---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-23
---

# Classifier Risk Only, Engine Owns Authorization

## Context
The goal doc's fuller design had the classifier LLM return a two-factor verdict
(`risk_level` × `user_authorization`), the second factor guessed from the
transcript — the codex/Guardian shape, which exists only because Guardian is
stateless. Gantry's engine is NOT stateless: it deterministically holds the
authorization facts (a conversation grant exists, the requester is an admin, a
capability covers the action, a trusted root applies). Making the LLM also guess
authorization is redundant and hallucination-prone.

## Decision
The classifier returns `risk_level` (low/med/high/critical) + rationale ONLY. The
coordinator derives the outcome from that risk and the authorization it already
holds: low/med → allow; high → allow iff authorization is held, else ASK;
critical → ASK (or hard-deny by rail). Codex RISK calibration lines are imported
verbatim (risk scoring is kept); the authorization half of the two-factor schema
is dropped from the LLM.

## Implementation Note — 2026-07-28

The shipped coordinator resolves reviewed agent authority before classifier
consultation. A request that reaches the classifier therefore maps low/medium
risk to run-local `allow_once` and high/critical risk to human approval; a
classifier error also requires approval and never auto-allows. The strict model
schema contains `risk_level`, optional `risk_category`, and `reason`.

Worker decision memory stores the derived classifier `allow`/`ask` together with
the risk level/category and reason. Only a cached `allow` is reused. The
versioned effect hash is parent-conversation scoped when that identity is
present; human `Allow once` never enters the cache.

## Consequences
Supersedes the two-factor LLM verdict described in the goal doc's fuller text
(the goal doc's "Leaner target" section already flags this). Authorization stays
a deterministic engine fact, not an LLM guess — simpler and more robust. The
classifier prompt and model verdict remain risk-only; the implementation note
above records the additional host-derived fields stored in decision memory.
