---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-12
stories:
  - WEB-CONSOLE-1
---

# Web Runtime Console: Private Read-only Integration

## Context

`apps/web` is currently a fixture-backed, source-only Vite application. The
runtime already exposes authenticated Control API reads, but a browser cannot
safely hold its privileged API key or read runtime storage directly. The
approved Web Runtime Console design starts with a private/local connection
foundation and intentionally defers OIDC, roles, mutations, and public
deployment.

## Decision

The Web Runtime Console uses a thin, server-side UI API under `/ui/api/*`.
It holds the Control API credential and calls the versioned Control API through
`@gantry/sdk`; the browser receives only browser-safe read models.

Phase 1 exposes connection health and the agent list only. It reuses the
existing `/v1/health` and `/v1/agents` contracts, removes production fixture
fallback for those screens, and makes no new browser-to-runtime or
browser-to-database connection.

## Consequences

- The UI remains a separately buildable application and may move to another
  service later by changing only its server-side Control API configuration.
- The Control API remains the authority for authorization, domain behavior,
  and operational state. The UI API does not parse Prometheus output or import
  runtime internals.
- The Control API credential is absent from browser bundles, HTML, browser
  requests, and UI logs.
- Initial hosting stays private/local. OIDC and authorization are required
  before any network-exposed deployment and need a separate approved design.
- No mutations, restarts, agent creation, or additional metrics/activity
  endpoints are introduced by this decision.
