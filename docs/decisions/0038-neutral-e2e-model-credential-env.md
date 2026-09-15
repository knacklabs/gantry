---
status: proposed
confirmed_by: ''
date: 2026-07-22
---

# Neutral E2E Model Credential Env

## Context

The real-model E2E scenario needs a Claude Code subscription token created by
`claude setup-token`. Provider-named secret configuration belongs in the
protected workflow, while test code should consume one step-local model
credential variable. GitHub workflow files are outside the provider-boundary
sentinel's scan scope.

## Decision

Tests read a neutral `E2E_MODEL_API_KEY` via a fixture helper
(`requireRealModelCredential()`); `.github/workflows/nightly-e2e.yml` maps the
GitHub repository secret to that step-local name
(`E2E_MODEL_API_KEY: ${{ secrets.E2E_ANTHROPIC_API_KEY }}`). The scenario
recognizes the setup token as a `claude_code_oauth` credential and stores it
through Gantry's public credential API.

## Consequences

- Test code carries no provider-named credential tokens; the API-seeding
  path of the scenario is unchanged.
- Future real-model scenarios use the same helper; local runs export
  `E2E_MODEL_API_KEY` directly.
- The protected GitHub secret contains the output of `claude setup-token`, not
  an Anthropic API key.
