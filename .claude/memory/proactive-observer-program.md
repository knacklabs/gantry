---
name: proactive-observer-program
description: "Curious Observer feature — proactive daily insight digest; design locked, staged build started 2026-07-21"
metadata: 
  node_type: memory
  type: project
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
---

**The Curious Observer**: a background agent that harvests team-chat firehose into the company
brain, a nightly pass mines it for insights (commitments/follow-ups, contradictions, open
questions, stale facts, decisions-without-owner, duplicated-work; repetition via the existing
pattern loop), a deterministic floor + a BATCH LLM judge gate them, and at most once/day it sends
the OWNER a PRIVATE digest. Goal: users see the agent's value without tagging it.

**Locked decisions (grilled + Fable/Codex adversarial review 2026-07-21):**
- Value gate: deterministic-first; the ONLY LLM judging rides the nightly batch — NEVER per-message
  (per-request LLM was the rejected auto-classifier cost trap). Cost-guard test asserts 0 LLM calls
  on the per-message path.
- Surface scope: per-channel opt-IN, default OFF (trust-safe; opt-out = surveillance framing).
- Cadence: threshold-gated, ≤1/day, quiet hours.
- **Batch IN v1**: extend the Model Gateway (NOT bypass — it rejects /v1/files+/v1/batches today);
  morning-after timing (submit night N → deliver when ready); transports Anthropic+OpenAI+xAI/Kimi;
  restart-safe IDEMPOTENT submit→poll→apply state machine (embedding impl orphans paid work on
  crash); own persisted token/USD accounting (embedding daily-cap not reusable).
- Settings: v1 wizard sets existing `memory.*` keys — NO `observer` facade (Codex: doesn't
  round-trip, erases mode on first revision sync).
- Full-quality v1: send-time freshness revalidation + evidence permalinks, semantic dedup, feedback
  capture. API + SDK + E2E on EVERY stage (user directive; E2E = merge bar).

**Critique-found must-builds (not reuse):** owner-identity primitive (none exists); dedicated
`proactive_insights` table w/ canonical semantic identity (NOT pattern_candidates); delivery
settlement (recipient/app/local-day uniqueness — today keyed by job/route → double-send). The plan's
cited `live-execution.ts` delivery seam was WRONG — delivery goes via scheduler notification routes +
needs a NEW trusted job identity.

**Staged build (~6–9 dev-weeks), via gantry-goal-pipeline (Codex implements):**
S1 foundations (data model + owner identity + activation + read-only API/SDK/E2E) — BUILDING on
`feature/observer-foundations` · S2 emission+floor+semantic-dedup · S3 batch (gateway ext + 4
transports + state machine + accounting) · S4 digest (staging+settlement+freshness+feedback+artifact)
· S5 wizard+preview+status+cold-start-backfill. Each stage behind `observer.enabled` (default off),
PR to main, E2E-gated.

Design of record: `scratchpad/proactive-observer-plan.md`; memory audit:
`scratchpad/memory-dreaming-audit.md` (both in this session's scratchpad). Builds on
[[company-brain-core-stage1]] (brain harvest + dream job) and [[proactive-surfacing-v1]] (pattern
loop + consent). Follows [[goal-pipeline-mandatory]].

**2026-07-22:** design of record COMMITTED as `docs/architecture/proactive-observer-goal-prompt.md` (contract gap closed; see [[symphony-forge-migration]]).
