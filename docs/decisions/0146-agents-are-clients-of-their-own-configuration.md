---
status: proposed
confirmed_by: ""
date: 2026-08-27
stories: [SELF-1, REVISION-1, DOCS-1]
---

# One API, three clients: agents may propose changes to themselves

## Context

Once the console ships, humans will rarely use the CLI; the CLI remains for break-glass (freeze when the console or IdP is down), fleet automation, and — the point of this decision — the agent itself. The product wants agents to improve without a human editing them, in a controlled way. Configuration is already desired-state revisions (ADR 0025) with a `PrincipalRef` author; nothing names the agent as a client of that API.

## Decision

Console, CLI, and the agent are three clients of one desired-state API. An agent may **propose** revisions to its own persona wording, routines and skills within its library scope, its default model within its allowlist, and its intro/help text. It may never change — even by proposal it can auto-apply — its access preset, tool rules, model allowlist, approvers, owner, connector accounts, or any other agent. Proposals are governed by the memory-governance knob (review or scoped auto-apply), applied as revisions under the agent's own `PrincipalRef`, posted to ADMIN-ALERT-1, and restorable in one action (REVISION-1). The CLI is documented as break-glass, automation, and the agent's surface — not the human's primary tool.

## Consequences

- SELF-1 implements this; REVISION-1 is a prerequisite.
- The privilege boundary is enforced server-side in the desired-state validator, not in the agent's prompt.
- Widening the proposable set (for example tool rules) requires a new decision.
