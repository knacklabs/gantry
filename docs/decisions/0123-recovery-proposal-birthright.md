---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-12
stories: [CAPFIX-1]
---

# Human-Gated Recovery Proposals Are Birthright — System Tools Never Need Approval

## Context

Live incident, 2026-08-12: the first real CAPFIX-1 amendment card was never
raised. The KnackLabs job hit the sheets template mismatch, followed the
guidance to propose an amendment via `request_access` — and that tool call was
itself terminally denied by the AUTODET-1 deterministic gate (0121), because
0052 deliberately left all `request_*` tools on the permission ladder and
CAPFIX-1 never reconciled the collision. Worse, the resulting pause card was
buttonless: exact tool grants for `request_access` are (rightly) refused as
durable authority, so the recovery classifier marked the blocker
non-grantable. The tool that asks for fixes needed a fix nobody could grant.
Ravi's ruling in chat: "System tools should never be needed for approval.
What's the point if the agent needs to ask for approval for its own tools."

## Decision

The five human-gated recovery-proposal tools — `request_access`,
`request_skill_install`, `request_skill_proposal`,
`request_skill_dependency_install`, `request_mcp_server` — are INPUT-GATED
BIRTHRIGHT on every run, interactive and autonomous (added to the 0052
input-gated set in permission-deterministic-rails). Rationale: these tools
only create review metadata; every effect requires an authenticated human
decision, so the human decision IS the authority and pre-gating the ask is a
deadlock by construction. Input-gating is retained: complete, inspectable
inputs pass; redacted/truncated inputs still fail closed.

Explicitly unchanged:
- These tools remain EXCLUDED from durable exact-tool grants
  (admin-mcp-tools): birthright at decision time, never a grantable
  authority.
- 0115 (autonomous denial terminal), 0121 (no classifier on autonomous runs),
  and 0122 (amendment card) all stand — this decision is what makes 0122
  reachable from the runs that need it.
- Fixed-image/locked-agent tool hiding and the yolo denylist still apply.

## Consequences

- Autonomous runs can always ASK: template amendments, skill installs, MCP
  server requests all surface as human cards instead of buttonless dead ends.
- Amends 0052: its "all request_* tools stay on the ladder" clause is
  superseded for exactly this five-tool set; the input-independent birthright
  list is unchanged.
- Rejected alternatives (do NOT re-propose): durable exact-tool grants for
  recovery tools; unconditional input-independent birthright (loses the
  fail-closed redaction guard); reviving the autonomous classifier for them.
- Follow-up (CAPFIX-2 scope): the job-lifecycle e2e should drive the real
  mismatch → request_access → card path end to end.
