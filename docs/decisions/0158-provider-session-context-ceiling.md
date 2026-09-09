---
status: accepted
confirmed_by: "Ravi"
date: 2026-09-09
stories: [cache-bug]
---

# Retire a persistent provider session after its observed context crosses a global cap

## Context

Every persistent interactive runner start resumes the stored provider session
and appends a fresh bounded briefing (decisions 0078, 0089). The briefing is
bounded; the transcript it accumulates in is not. Nothing expires a provider
session by age, turn count or size: the idle timeout closes runner stdin only,
`/compact` is explicit, and SDK autocompact fires at the model's context
window. Production evidence: a one-word Slack turn read ~270k cached input
tokens on each of two model calls (~541k for the turn). Prompt caching
discounts the repeated prefix; it does not shrink the context.

Both runners already report an authoritative per-run context figure:
`AgentOutput.contextUsage` (`RuntimeContextUsageSnapshot.totalTokens`, from
the Claude SDK's `getContextUsage()` and DeepAgents' `terminalContextUsage`).
Where it is absent, normalised usage carries `inputTokens`, `cacheReadTokens`
and `cacheWriteTokens`, but `totalBillableInputTokens` subtracts cache reads
and cannot serve as a context measure. The spec grill (docs/specs/cache-bug.md)
chose the minimal containment: retire after an observed crossing, no hard
mid-run bound, no per-request seam, no model-capacity clause.

## Decision

1. A persistent interactive provider session carries a typed, nullable integer
   `provider_sessions.context_high_water_mark` (0017: resume-governing state
   is a typed column). After any run whose output carries a measurement, the
   host raises it to `max(existing, observed)` through one fenced SQL update
   (provider-session id, agent-session ownership, resumable status, and
   `agent_sessions.reset_at` compared null-safely).
2. The observed value is `contextUsage.totalTokens` when the run reports it;
   otherwise `modelVisibleInputTokens`, derived from normalised usage using
   two explicit per-route registry booleans (`cacheReadsIncludedInInput`,
   `cacheWritesIncludedInInput`): additive providers (Anthropic) sum input +
   cache read + cache write; inclusive providers (OpenAI, OpenRouter) use
   input alone; unresolved or mixed routes use the additive form.
3. Before resuming, if the mark exceeds `limits.provider_session_max_input_tokens`
   (global revisioned setting per 0025; integer 20,000–900,000; default
   150,000; `CURRENT_SETTINGS_READER_VERSION` bumped — the importer stamps
   every subsequent revision with it, so older workers hold their last
   revision and alert), the
   host retires the session through one atomic `active`→`expired` transition
   that returns the retired reference, and starts fresh from the ordinary
   bounded briefing. `ready` rows are promoted first; `maintenance_compact`
   rows are never retired by the ceiling. One overshoot run is allowed and
   stated: this is a retire-after-observed-crossing rule, not a hard bound.
4. No data migration, cleanup flow, or lazy retirement for pre-existing
   sessions (0003, 0112) — the generated schema migration that adds the
   column is the only migration: the deployment owner runs a documented
   drained-runtime reset before deploy; sessions without a mark resume
   normally.

## Consequences

- Turn cost and latency are bounded to roughly one cap's worth of context
  plus one overshoot; cross-process continuity for ordinary conversations is
  unchanged.
- Rejected simpler shape: a ceiling on `totalBillableInputTokens` — it would
  record near zero for a fully cached 270k prompt and never retire.
- Rejected larger shapes: dropping the snapshot on resume (contradicts 0089),
  a per-request measurement seam and a model-capacity-aware cap (parked with
  a revisit trigger: the per-run figure proves too coarse), briefing-only
  reconstruction across restarts.
- A delta snapshot on resume is parked: revisit if retirement alone leaves
  turns too expensive.
- Two runtime events, `session.provider.retired` and
  `session.provider.cleanup_failed`, are published directly by the host
  through the runtime event exchange (0013) with hashed identifiers.
