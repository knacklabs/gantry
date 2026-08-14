---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-14
stories:
  - WEB-CONSOLE-6
supersedes: 0124-web-runtime-console-read-only-integration
---

# Web Runtime Console: Agent Creation

## Context

The private Web Runtime Console already reads Gantry state through a thin,
same-origin UI API. That boundary keeps the Control API key, raw settings, and
runtime-only data out of the browser, but the preceding decision deliberately
prohibited all writes. Local operators now need one reliable, recoverable way
to create an agent without falling back to manual multi-surface setup.

Agent creation crosses several durable authorities: the agent record and
desired-state revision, agent access and delegation, conversation installs,
and optionally a scheduler job. A browser-side sequence would be neither
idempotent nor safe to resume after a failure.

## Decision

Supersede the read-only prohibition only for an app-scoped, server-mediated
agent-creation workflow. The browser continues to call same-origin `/ui/api/*`;
the UI server holds the Control API credential and exposes narrowly projected
drafts, options, preflight results, progress, and receipts.

Creation drafts and staged commit/recovery are Control-owned durable state.
The Control service claims a draft with a lease, reserves stable identifiers,
and records stage progress so retries create or verify the same agent,
conversation install, and optional job rather than duplicating them. Existing
settings, access, conversation, and job services remain authoritative.

## Consequences

- This is the first permitted Web Console mutation; it is local/private only
  until a separately approved authentication and authorization design exists.
- The browser never receives Control credentials, app IDs, raw settings,
  source definitions, storage references, environment requirements, secrets,
  or internal preflight diagnostics.
- Drafts are shared within the app until authentication introduces user
  ownership. Completed receipts are retained for 30 days solely for idempotent
  replay and then cleaned up in bounded batches.
- Failures after an agent record exists leave it safely unrouted and marked
  `needs_attention`; resume retries only incomplete durable stages. There is
  no hard delete, rollback, restart, reconciliation, OIDC, role management,
  or credential-entry flow in this decision.
