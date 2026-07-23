---
name: dev-experience-gap-analysis
description: "Exam-guide audit produced docs/architecture/dev-experience-gap-analysis.md + dev-control-and-observability-goal-prompt.md (Tier 1 approved, not yet implemented)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 60294553-f2ce-49f9-a192-c146585f09cc
---

2026-07-11: Audited Gantry against the Claude Certified Architect exam guide via three codex xhigh read-only sweeps. Wrote two docs (initially uncommitted): `docs/architecture/dev-experience-gap-analysis.md` (ranked B1-B3 bugs / P1-P12 parity gaps / I1-I3 pillars with file:line evidence) and `docs/architecture/dev-control-and-observability-goal-prompt.md` (Tier 1, five stages A-E).

Key code-truth: `effort` is silently dead on the DeepAgents inline lane AND the whole worker path (B1/B2); `mcp_call_tool` flattens nested remote `isError` (B3); count_tokens is gateway-allowlisted but publicly unmounted; `packages/sdk` typed client + full webhook delivery machinery + `event_bus_outbox` already exist (pillars are wiring, not building); replay/eval blocked on missing run-input manifest (capture seam: group-processing.ts ~713-735).

User decisions: Tier 1 = control+truth bundle + typed SDK + webhooks; knobs = per-agent settings defaults + per-request overrides on sessions API; P12 spend guards folded back in at user direction; worker `/thinking` override keeps winning over settings.

Tier 1 SHIPPED as PR #209 (feature/dev-control-observability, 2026-07-11, 20 commits, 126 files): all stages A-F via the pipeline (codex gpt-5.6-sol xhigh). Autoreview r1 found per-key-ceiling bypass (omitted max_tokens / n>1) → fixed; r2 clean. Pipeline lessons: codex handoffs must say "STOP and ask on scope mismatch" + "no autoreview" (Stage A wedged 3h in a self-started autoreview; all processes dead while companion showed running — check `ps` before trusting status); new agent-spawn-host exports broke two integration suites' vi.mocks (export-parity class); generated SDK types must be prettier-ignored or the pre-commit hook fights check:generated; migration-count and event-sequence test assertions break on every addition — write contains-not-last. Tier 2 backlog: hooks, validation-retry, /v1/usage; Tier 3: fork, MCP resources, batches, replay/eval.
