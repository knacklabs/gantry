---
status: proposed
confirmed_by: ""
date: 2026-08-26
stories: [ONBOARD-UI-1, UI-CONN-ACCOUNTS-1]
---

# Browser write-only secret ingest for provider and connector secrets

## Context

Provider Accounts and Connector Accounts reference secrets by `gantry-secret:`,
`env:`, or `aws-sm:` references. Today only the CLI can create a Gantry-held
secret, so a browser onboarding flow cannot connect a Slack or Teams seat
without a terminal. Decision 0135 already allows the browser to *submit* a
model-provider credential value that is never returned.

## Decision

Extend the 0135 pattern into one narrow, write-only secret-ingest facade:
the browser submits a value once over the same-origin, Origin+CSRF, hosted
re-authenticated administrator path; the server stores it in the Gantry secret
provider and returns only the generated `gantry-secret:` reference. No facade
ever returns a secret value; existing `env:`/`aws-sm:` references may be
selected by name. A shared `SecretRefField` component validates references
client-side and offers the write-only entry for raw values.

## Consequences

- Ingest events are audited with the actor `PrincipalRef` and the reference, never
  the value.
- Rotation reuses the same endpoint; revocation of a reference that is still
  bound fails closed.
- Fleet/locked posture may disable browser ingest by policy; the CLI path stays.
