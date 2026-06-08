# Credential Boundary

## Context

Gantry needs local and enterprise credential handling without exposing raw
model-provider keys to agents, tools, browser automation, MCP servers, or shell
commands. Runtime secrets, model credentials, and capability credentials have
different trust boundaries and must not share one env-var-shaped abstraction.

## Decision

- Runtime-owned secrets come from `RuntimeSecretProvider`.
- Model-provider credentials are stored as typed encrypted model credentials
  and used only by the Gantry Model Gateway.
- Capability credentials are typed encrypted capability secrets scoped to
  selected skills, MCP servers, and reviewed tools.
- Agent model runs receive a loopback gateway URL and a run-scoped `gtw_*`
  token, never raw provider API keys.
- Agent actions still go through `PermissionPolicyService` before any
  capability credential is projected to a runner process.
- Do not add Vault, AWS, GCP, Azure, or Kubernetes implementations until a
  specific deployment mode requires them.

## Consequences

Runtime code can depend on credential ports and application services, but it
must not read model-provider keys directly. Tools, browser automation, MCP
servers, and shell commands do not receive model credential env.

## Runtime Secret Scope

Runtime-owned secrets include:

- Postgres URL
- Slack bot token
- Slack app token
- Telegram token
- webhook secret
- control API secret
- `SECRET_ENCRYPTION_KEY`

These secrets configure and operate the runtime. They are not model credentials
or capability credentials.

## Agent Credential Scope

Agent-accessed credentials include:

- model-provider access through Gantry Model Gateway
- selected tool and API credentials through capability credentials

Model transport is passed only to the Claude SDK process through the gateway
projection. Tool/API credentials must be modeled as explicit capability
projections instead of ambient process environment.
