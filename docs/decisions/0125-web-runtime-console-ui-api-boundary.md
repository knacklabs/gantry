---
status: proposed
confirmed_by: ""
date: 2026-08-12
stories: [WEB-CONSOLE-1]
---

# Web runtime console uses a thin UI API boundary

## Context
The Web Runtime Console must show real Gantry runtime data in a private/local
browser UI without exposing Control API credentials to browser JavaScript.

Accepted decisions already require the Admin Web UI to remain a separate app
from runtime internals, with supported integration through the SDK/Control API.
The existing `apps/web` foundation is fixture-backed and has no API client,
server route, authentication, or runtime hosting path. Phase 1 needs only
connection health and agent list reads, so a direct runtime import, direct
Postgres read, new server framework, or browser-held Control API key would add
unneeded coupling and security exposure.

## Decision
The browser-facing web app will call private same-origin routes under
`/ui/api/*`. Those routes are owned by the web/runtime serving process, hold the
server-side Control API credential, and communicate with Gantry through the
existing versioned Control API contracts, preferably via `@gantry/sdk`.

`/ui/api/*` routes are not a second domain API. They are a thin browser-safe
projection layer for UI state, error normalization, and small screen-level read
composition.

## Consequences
The browser never receives a Control API key and never queries Postgres or
runtime internals directly. The Control API remains the authority for runtime
data, scopes, app identity, and errors.

The UI API may combine existing reads for one screen when it reduces browser
round trips, but it must not duplicate runtime business logic, parse Prometheus
metrics text, cache durable state outside a short in-process read TTL, or expose
credentials, leases, private correlation IDs, raw provider payloads, or internal
database rows.

This keeps the first private/local deployment simple while preserving a later
path to host the web artifact on another service: only the server-side Control
API base URL and credential move.
