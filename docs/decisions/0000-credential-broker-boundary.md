# Credential Broker Boundary

## Context

MyClaw needs to support personal and enterprise deployments. OneCLI is a good
default credential broker for local and personal mode because it gives agents
brokered model access without placing raw model-provider credentials in the
runtime `.env`.

Enterprise deployments may use OneCLI, Vault, Kubernetes Secrets, AWS Secrets
Manager, GCP Secret Manager, Azure Key Vault, or a custom broker. The runtime
must not require OneCLI as the only credential architecture.

## Decision

- Runtime-owned secrets and agent-accessed credentials are separate concerns.
- Runtime-owned secrets come from `RuntimeSecretProvider`.
- Agent-accessed credentials come from `AgentCredentialBroker`.
- OneCLI is one `AgentCredentialBroker` adapter, not a core runtime dependency.
- The OneCLI SDK import is allowed only inside the OneCLI credential adapter and
  the CLI setup adapter.
- Agent credential injection may return broker-safe environment variables,
  proxy references, and certificate file references. It must not return raw
  secret values.
- Agent actions still go through `PermissionPolicyService` before broker-safe
  credential injection is applied to a runner process.
- Do not add Vault, AWS, GCP, Azure, or Kubernetes implementations until a
  specific deployment mode requires them.

## Consequences

Personal setup keeps the OneCLI default path. Enterprise setup can later replace
the broker adapter without rewriting runtime agent spawning, memory LLM access,
or preflight checks.

Runtime code can depend on the credential broker port and application service,
but it must not instantiate OneCLI or import `@onecli-sh/sdk` directly.

## Runtime Secret Scope

Runtime-owned secrets include:

- Postgres URL
- Slack bot token
- Slack app token
- Telegram token
- webhook secret
- control API secret
- OneCLI database URL
- OneCLI encryption key

These secrets configure and operate the runtime or broker service. They are not
agent credentials and must not be requested from `AgentCredentialBroker`.

## Agent Credential Scope

Agent-accessed credentials include:

- LLM provider access
- tool and API credentials the agent is authorized to use

The broker returns only a safe injection contract for the runner, such as
provider base URLs, local provider-only proxy endpoints, and certificate file
paths. Model proxy transport is passed only to the Claude SDK process, with SDK
subprocess environment scrubbing enabled so general-purpose tools do not inherit
it. Future tool/API credential lanes must be modeled as explicit capability
projections instead of ambient process environment.
