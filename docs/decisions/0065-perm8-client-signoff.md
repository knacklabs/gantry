---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-26
---

# Perm8 Client Signoff

## Context
Ravi tried to grant "allow for future" for `scheduler_resume_job` and the button was not
there. The last prompt's stored options were `["allow_once","cancel"]`.

Why: the prompt offers the persistent option only when the suggestion synthesizer emits a
persistent suggestion, which requires `validateDurableAccessRule` to accept the tool name.
That validator accepts a hand-maintained list — `DURABLE_SCHEDULER_MCP_TOOL_NAMES`
(`shared/admin-mcp-tools.ts:32`) — containing the scheduler reads plus `run_now`, and no other
mutation. Its own rejection message claims exact scheduler tools are supported. So today you
can durably grant "run this job now" but not "resume this job", which is an unfinished list,
not a policy.

An audit of every model-visible tool against the real validator showed the problem is
system-wide: only scheduler reads, `run_now`, Browser, file tools and scoped `RunCommand(...)`
can ever receive the button. Every scheduler mutation, the task lifecycle tools,
`delegate_task`, the async commands, memory mutations, `mcp_call_tool` and the `request_*`
family are allow-once forever — no grant a human makes can stick.

## Decision
Ravi decided on 2026-07-26: **every exact gantry tool becomes durable-grantable, except the
authority-changing `request_*` family** (`AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES`). Those
change what the agent is even capable of — install skills, add servers, request new access —
and keep asking every time.

The line moves from a hand-maintained list to a single rule, so it cannot drift out of step
with the tool surface again.

The button only appears; nothing is granted until the human taps it. Auto-allow policy
(birthright, rails, classifier) is untouched.

## Consequences
- A durable grant is a standing human decision. The risk accepted is a fat-fingered permanent
  grant on a destructive tool (e.g. `scheduler_delete_job`); the mitigations are that the
  prompt names the tool and the risk label, and revocation exists.
- `request_*` stays allow-once by design. If that ever changes it is its own decision.
- Existing granted rules and their matching are unchanged; this widens only what MAY be
  granted.
- Free-form MCP passthrough (`mcp_call_tool`) becomes grantable as an exact tool name; the
  grant covers the passthrough tool itself, not any specific remote tool behind it. If
  per-remote-tool scoping is wanted later, that is a rule-grammar extension, not this change.
