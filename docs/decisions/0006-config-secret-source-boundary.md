---
status: accepted
confirmed_by: "vrknetha"
date: 2026-04-26
---

# Config and Secret Source Boundary

## Context

Gantry must support local personal installs and enterprise deployments with
different secret backends. A single global precedence chain across
`settings.yaml`, `.env`, process env, and credential stores makes it too easy
for a misplaced value to silently override the intended architecture.

## Decision

Gantry uses lane-specific ownership:

- Non-secret configuration belongs in settings revisions; `settings.yaml` is the
  readable import/export copy.
- Runtime-owned secrets come from `RuntimeSecretProvider`.
- Model-provider credentials come from typed encrypted model credentials and
  Gantry Model Gateway.
- Capability credentials come from typed encrypted capability secrets.
- Wrong-lane values are configuration errors.

Runtime secrets are selected by explicit refs in settings:

- `env:<NAME>` resolves through process env and runtime `.env`.
- `gantry-secret:<NAME>` resolves through encrypted Gantry secret rows.
- `aws-sm:<name-or-arn>` resolves through AWS Secrets Manager.

Guided provider setup stores channel tokens as `gantry-secret:` refs by
default. Runtime `.env` may still contain runtime-owned secrets such as database
URLs, webhook/control secrets, and `SECRET_ENCRYPTION_KEY` when those values are
referenced with `env:`.

Runtime `.env` must not contain non-secret configuration such as model
selection. It must also not contain raw model-provider credentials such as
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN`.

The same wrong-lane policy applies to the process environment. Process env may
override runtime `.env` for runtime-owned secrets only; it must not be used for
settings-owned values, model-provider credentials, or capability credentials.

## Precedence

Precedence is scoped to each lane:

- Configuration: CLI flag when present, then latest settings revision, then
  synced `settings.yaml` bootstrap/import copy, then built-in defaults.
- Runtime-owned secrets: the active `RuntimeSecretProvider` decides source
  order from the explicit ref. The built-in chain supports encrypted Gantry
  secrets, AWS Secrets Manager, and local env refs.
- Model-provider credentials: Gantry Model Gateway resolves the latest enabled
  typed credential for the selected provider route.
- Capability credentials: the capability credential service resolves only
  credentials explicitly scoped to selected capabilities.

## Consequences

Doctor and preflight report wrong-lane keys with exact destinations instead of
silently ignoring them.

Future Vault, Kubernetes Secrets, AWS Secrets Manager, GCP Secret Manager,
Azure Key Vault, or custom providers should be added behind the existing
provider ports. Runtime-owned secrets use `RuntimeSecretProvider`; model and
capability credentials use typed credential services.
