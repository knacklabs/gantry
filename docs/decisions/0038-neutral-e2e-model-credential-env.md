---
status: proposed
confirmed_by: ""
date: 2026-07-22
---

# Neutral E2E Model Credential Env

## Context

The real-model E2E scenario gates on `E2E_ANTHROPIC_API_KEY`, tripping the
provider-boundary sentinel in test code (3 tokens in
`apps/core/test/agent-e2e/scenarios/haiku-turn.agent-e2e.test.ts`). The debt mechanism ratchets exact counts and
would preserve provider-token leakage rather than fix it. GitHub workflow
files are outside the sentinel's scan scope.

## Decision

Tests read a neutral `E2E_MODEL_API_KEY` via a fixture helper
(`requireRealModelCredential()`); `.github/workflows/ci.yml` maps the existing GitHub secret to
that neutral name (`E2E_MODEL_API_KEY: ${{ secrets.E2E_ANTHROPIC_API_KEY }}`).
The GitHub secret itself is not renamed.

## Consequences

- Test code carries no provider-named credential tokens; the API-seeding
  path of the scenario is unchanged.
- Future real-model scenarios use the same helper; local runs export
  `E2E_MODEL_API_KEY` directly.
