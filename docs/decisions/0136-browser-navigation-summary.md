---
status: accepted
confirmed_by: "Ashirwad Shetye"
date: 2026-08-27
stories: [AGENTS-WEB-1]
---

# Browser Navigation Summary

## Context

The web console sidebar needs compact counts for agents, MCP servers, and
model providers. Fetching each full page (or several filtered agent pages)
from the application shell would duplicate work, scale poorly, and make it
easy for tooltip copy to imply a status that the runtime does not measure.

## Decision

Expose one authenticated, same-origin read-only `/ui/api/navigation-summary`
browser façade. It returns app-scoped aggregate counts only: agent total,
active, disabled, and without-role; MCP active and disabled; and model-provider
ready, missing, and disabled.

The sidebar prefetches this single payload when the authenticated shell loads,
refreshes it on window focus and at a modest interval, and invalidates it after
relevant mutations. Labels follow the underlying truth: MCP servers are
“active”, not “connected”; provider “ready” is stored credential health, not a
live upstream reachability promise.

## Consequences

- The browser response is session-bound, no-store, and redacted; it exposes no
  provider credentials, agent prompts, endpoints, bindings, or raw records.
- A single count pill on each relevant navigation row reveals exact breakdowns
  in an accessible tooltip. Failed or pending fetches do not render false zero
  counts.
- Runtime reachability remains the header’s separate `Runtime connected`
  signal. This decision adds no background provider verification or MCP
  liveness probe.
