---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-12
stories: [CAPFIX-1, JOBFLOW-1]
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

Decision 0125 supersedes this record only where it made capability-template amendments
reachable through an agent-authored `request_access` target. That amendment target is
removed and template-mismatch proposals are host-compiled only. `request_access` remains
input-gated birthright for its other human-gated recovery targets, and the other four
birthright recovery tools are unchanged.

Explicitly unchanged:
- These tools remain EXCLUDED from durable exact-tool grants
  (admin-mcp-tools): birthright at decision time, never a grantable
  authority.
- 0115 (as amended by 0126/0127) and 0121 (no classifier on autonomous runs)
  stand. Decision 0125 owns the host-only template-amendment entry path.
- Fixed-image/locked-agent tool hiding and the yolo denylist still apply.

## Consequences

- Autonomous runs can always ask for the remaining human-gated access, skill, and MCP
  recovery proposals. Capability-template mismatch proposals are filed by the host under
  decision 0125.
- Amends 0052: its "all request_* tools stay on the ladder" clause is
  superseded for exactly this five-tool set; the input-independent birthright
  list is unchanged.
- Rejected alternatives (do NOT re-propose): durable exact-tool grants for
  recovery tools; unconditional input-independent birthright (loses the
  fail-closed redaction guard); reviving the autonomous classifier for them.
- Follow-up (CAPFIX-2 scope): the job-lifecycle e2e should drive the real
  mismatch → request_access → card path end to end.
