---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-16
stories: [CAPSAFE-1]
---

# capability_run auto-allow is dispatch-only

## Context

`mcp__gantry__capability_run` is an unscoped dispatcher when judged by tool name alone,
but its host handler resolves the selected semantic capability and validates the exact
argv against the reviewed template before execution. Prompting for the wrapper itself
duplicates authorization; classifying the wrapper as generically low-risk would let
unrelated callers or a stale classifier verdict bypass the host boundary. As the
terminal-wildcard change (0129) makes reviewed prefixes cover ordinary flags, it is
important that this convenience never becomes a way to grant command authority from the
runner or classifier side.

## Decision

The canonical `mcp__gantry__capability_run` wrapper may bypass runner-side approval only
to dispatch to the Gantry host, and only when:

- the request passed schema validation;
- the YOLO denylist did not match; and
- the canonical host handler will perform current target authorization.

The bypass grants no command authority. Before execution the host re-resolves app, agent,
person, run, conversation, selected capability, reviewed template, executable identity,
sandbox, and egress policy. A template mismatch may still reach the host compiler but can
never execute. `capability_run` remains high-risk in the generic Gantry risk map; it
receives no classifier-derived or cached allow. Non-Gantry lookalikes, other unscoped
dispatchers, malformed inputs, missing host authority, and unavailable repositories all
fail closed through their existing paths.

## Consequences

There is one authorization implementation: the host capability resolver plus the shared
argv matcher from 0129. The runner performs only a narrow dispatch hand-off. Interactive
and autonomous execution retain the same durable capability authority, while mismatch
recovery remains reachable. This keeps the simplification of 0129 safe: broadening what a
prefix authorizes does not broaden who may authorize a prefix.
