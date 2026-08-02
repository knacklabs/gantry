---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-23
---

# Runtime Hardening Audit Harvest

## Context
A risk-directed audit of `main` (`ddfe0d614`, 2026-07-22) surfaced three
high-impact security boundary weaknesses and four scalability weaknesses, plus
simplification opportunities. Findings were re-verified against current `main`
(`ce61ac1`) on 2026-07-23 — all nine security/performance findings still exist.
The client directed harvesting these into tracked goals, security and performance
first. Full detail: `docs/architecture/runtime-hardening-audit-2026-07-22.md`.

## Decision
Adopt a `runtime-hardening-audit` epic with 13 stories in execution order —
security (SEC-1 CI runner, SEC-2 attachment writer, SEC-3 LLM concurrency), then
performance (PERF-1 IPC replay, PERF-2 job N+1, PERF-3 SSE race), then the two
architecture-decision items (SEC-4 cluster rate limits, PERF-4 live-admission
caps/retention), the CI gate (CI-1), and four simplifications (SIMP-1..4). The
decision-status-parser audit finding is excluded as not-applicable on the current
frontmatter corpus. Overlaps are cross-referenced, not duplicated: PERF-3↔CO-2,
PERF-4/SIMP-4↔DUR-1, CI-1↔E2E-3.

## Consequences
- SEC-4 and PERF-4 each open with a required architecture decision before code.
- PERF-3, PERF-4, and SIMP-4 must reconcile with CO-2 / DUR-1 so each fix lands
  once; sequence after those lanes touch the same surface.
- SEC-2 and PERF-4 touch files the ponytail cutover moves — sequence after the
  cutover or rebase onto it.
- Security and performance stories are ordered ahead of the simplifications.
