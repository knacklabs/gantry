# Config and Secret Source Boundary

## Context

MyClaw must support local personal installs and enterprise deployments with
different secret backends. A single global precedence chain across
`settings.yaml`, `.env`, process env, and credential brokers makes it too easy
for a misplaced value to silently override the intended architecture.

## Decision

MyClaw uses lane-specific ownership:

- Non-secret configuration belongs in `settings.yaml`.
- Runtime-owned secrets come from `RuntimeSecretProvider`.
- Agent-accessed credentials come from `AgentCredentialBroker`.
- Wrong-lane values are configuration errors.

Runtime `.env` is the local/personal `RuntimeSecretProvider` source. It may
contain runtime-owned secrets such as database URLs, bot tokens, webhook/control
secrets, OneCLI database URL, and the OneCLI encryption key.

Runtime `.env` must not contain non-secret configuration such as credential
broker mode, broker endpoint URLs, or default model selection. It must also not
contain raw agent-accessed credentials such as `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN`.

The same wrong-lane policy applies to the process environment. Process env may
override runtime `.env` for runtime-owned secrets only; it must not be used for
settings-owned values or agent-accessed credentials.

## Precedence

Precedence is scoped to each lane:

- Configuration: CLI flag when present, then `settings.yaml`, then built-in
  defaults.
- Runtime-owned secrets: the active `RuntimeSecretProvider` decides source
  order. The local env provider uses process env and runtime `.env`.
- Agent-accessed credentials: the selected `AgentCredentialBroker` is the only
  source. Runtime `.env` and process env do not supersede broker credentials.

## Consequences

This is a clean cutover. Existing local `.env` files that contain broker mode,
broker URLs, model settings such as `ANTHROPIC_MODEL`, or raw model-provider
credentials must be fixed. Doctor and preflight should report the exact key and
destination instead of silently ignoring the value.

The supported local cleanup path is manual one-time cutover. Move known
settings-owned `.env` values into `settings.yaml`, remove raw agent-accessed
credentials from `.env`, and recreate those credentials in the selected broker.

Future Vault, Kubernetes Secrets, AWS Secrets Manager, GCP Secret Manager, Azure
Key Vault, or custom providers should be added behind the existing provider
ports. Runtime-owned secrets use `RuntimeSecretProvider`; agent-accessed
credentials use `AgentCredentialBroker`.
