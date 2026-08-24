---
status: accepted
confirmed_by: "Ashirwad Shetye"
date: 2026-08-24
stories: [WEB-PROVIDERS-1]
---

# Browser model-provider credential facade

## Context

Model-provider credentials already have a machine-oriented `/v1/credentials/models`
surface protected by Control API Bearer credentials. The web console now needs
to list provider readiness, set or rotate credentials, disable credentials, and
run an explicit verification without ever receiving a Control API credential or
provider secret. Decision 0132 requires browser routes to be independently
authorized, same-origin, CSRF-protected, and explicitly classified.

## Decision

The Control server will expose a narrow same-origin `/ui/api/model-providers`
facade for the web console. It resolves the opaque browser session server-side,
allows Viewer read-only access and Administrator mutations, and applies the
same canonical-Origin, synchronizer-CSRF, recent-reauthentication, audit, and
secret-redaction rules as the existing browser-auth routes.

The façade calls application services directly; it never forwards browser
cookies to `/v1/*`, accepts a Bearer token, returns a secret, or changes the
existing Bearer-only Control API contract. It reports why a provider is
required from the effective runtime configuration and makes verification an
explicit administrator action that returns only safe outcome metadata.

## Consequences

- `credentials:read` and `credentials:admin` are classified as browser-safe
  only through this façade, with role-specific access rather than a generic
  proxy.
- Provider inventory remains registry-derived and unknown/unsupported provider
  IDs fail closed. Credential values, API keys, tokens, and raw upstream
  responses never enter browser payloads, logs, or audit events.
- The existing CLI verification logic is moved behind a shared application
  boundary so the Control server does not import the CLI. Verification failure
  remains actionable but does not persist a failed credential.
- This does not add custom providers, provider deletion, profiles, search,
  background monitoring, or Activity links while Activity is fixture-backed.
