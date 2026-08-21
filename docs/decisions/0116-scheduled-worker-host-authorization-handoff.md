---
status: proposed
confirmed_by: ""
date: 2026-08-08
stories: [CAPRULE-1]
---

# Scheduled Worker Host Authorization Handoff

## Context

On a scheduled (autonomous) run in the anthropic_sdk worker lane, a tool command is
authorized against `currentAutonomousAllowedToolRules()`
(`apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts:123`),
evaluated at `:396`. By design (PERM-2 Task F, `:108`) that worker-side set carries
only the `RunCommand(date *)` birthright, external-MCP rules, host-approved live rules,
and in-session operator approvals — it deliberately **excludes** the agent's configured
capability/command grants, so a compromised worker cannot self-grant from its own
visible `allowedTools`.

The consequence (observed live on the KnackLabs Lead Maintenance job, confirmed by a
read-only Codex validation): a command the agent is genuinely granted — a
`google.sheets.values.get` capability that projects to
`RunCommand(/opt/homebrew/bin/gog sheets get *)` — is denied as *"not on the autonomous
run allowlist,"* because that reviewed authority lives in the host's snapshot
(`execution.ts:359/498`, projected to SDK `allowedTools` at
`agent-spawn-input-projection.ts:47`) but never becomes worker authorization. The rule
matcher, `resolveCapabilityRules`, and the capability projection are all correct; the
authority simply never reaches the scheduled worker decision. The host-side alternatives
(agent-identity mismatch; the skill-activation gate) were both refuted.

## Decision

A scheduled worker-lane permission **miss** must not be terminal on its own. Before a
scheduled tool denial becomes terminal, the worker consults the existing **host
coordinator's reviewed-rule decision** (the same host authority the DeepAgents/interactive
paths already use), which holds the agent's reviewed durable capability + command rules
and their semantic-capability definitions. If the host authorizes the tool, the run
proceeds; only if the host also denies does the denial become terminal (and route to the
SCHED-6 pause/instruction flow).

The worker's own `currentAutonomousAllowedToolRules()` set is **not** widened with the
agent's configured SDK `allowedTools`; doing so would re-open the PERM-2 self-grant
bypass. Authority remains host-reviewed; the worker gains a *handoff*, not new local trust.

## Consequences

- Scheduled runs can use exactly the capabilities/commands the host has reviewed for the
  agent — no more, no less. Ungranted capabilities still deny (the host denies too).
- PERM-2's invariant is preserved: the worker never self-authorizes from its own visible
  tool surface; the durable authority stays on the host.
- Adds a host round-trip on a scheduled worker-local miss (only on the miss path; hits
  and birthright short-circuits are unchanged). Acceptable — it is the same host
  coordinator call the other lanes already make.
- Implementation boundary is the scheduled branch at
  `tool-permission-gate.ts:396`; no change to the matcher, `resolveCapabilityRules`, the
  capability projection, or the interactive path.
