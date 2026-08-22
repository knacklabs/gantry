---
status: proposed
confirmed_by: ""
date: 2026-08-22
stories: [NOTIFY-1-T7]
---

# Gantry Tool Correlation Response Meta

## Context
Every tool call emits a generic terminal `tool.activity` event (from the worker's
PostToolUse hook / DeepAgents normalizer). Gantry-owned tools (capability-run,
browser) ALSO emit an authoritative host event carrying the real action. The
projection must dedup the pair into one item, so both events need the SAME
`invocationId`.

The two events are produced in different places with different identifiers:
- the generic event has the model provider's `tool_use_id` (only available in the
  worker/SDK layer);
- the authoritative event has `taskId` (`makeIpcId`), generated inside the MCP
  subprocess that runs the tool. That subprocess never receives the model's
  `tool_use_id` — MCP tool calls do not carry it — and no host context holds both
  ids, so "request-side propagation" (host -> tool) of the provider id is not
  feasible without re-architecting capability/browser execution off the IPC path.

An autoreview pass argued the generic event should always use the provider id and
never read the tool result. Applied literally that severs the only correlation the
architecture allows and silently breaks production dedup (the generic event keyed
by `tool_use_id`, the authoritative event by `taskId` — a capability call then
appears twice).

## Decision
Gantry-owned tools correlate their generic and authoritative events through the
tool RESULT's private `_meta.invocationId` (= `taskId`), read back by the generic
hook ONLY for Gantry-owned families. Third-party tools always use the provider id;
their result `_meta` is never trusted for identity (extraction is `_meta`-only and
Gantry-family-gated, per the R2 hardening). Request-side propagation is rejected as
infeasible given the MCP subprocess boundary.

## Consequences
- Correlation for capability/browser stays functional and the third-party hijack
  vector stays closed (`_meta`-only, Gantry-family-gated).
- The design depends on MCP result `_meta` surviving the SDK round-trip, which is
  spec-supported and is our own tool's metadata; accepted.
- Reopen only if capability/browser execution is moved off the IPC boundary such
  that the model `tool_use_id` becomes available where the authoritative event is
  emitted.
