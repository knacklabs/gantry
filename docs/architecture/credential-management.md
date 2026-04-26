# Credential Management

MyClaw separates runtime-owned secrets from credentials that agents may access
through a broker.

## Source Lanes

MyClaw uses three source lanes:

- `settings.yaml` stores non-secret configuration, such as credential broker
  mode, broker endpoint URLs, channel enablement, schemas, allowlists, and
  model selections.
- `RuntimeSecretProvider` resolves runtime-owned secrets. The local/personal
  implementation reads runtime `.env` and process env for values such as
  database URLs, channel bot tokens, webhook/control secrets, and OneCLI
  persistence secrets.
- `AgentCredentialBroker` resolves agent-accessed credentials. It may return
  only broker-safe injection values such as provider base URLs, proxy
  references, and certificate file paths.

There is no global `.env > broker` precedence. Precedence is lane-specific:
settings choose behavior, runtime secret providers resolve runtime secrets, and
agent credentials come only from the selected broker. If a value appears in the
wrong lane, MyClaw reports it as a configuration error instead of silently
ignoring or overriding it.

Wrong-lane checks apply to both runtime `.env` and the process environment used
to start MyClaw. Process env may override local `.env` only inside
runtime-secret resolution; it is not a supported path for broker mode, broker
URLs, model settings, Slack approvers, or raw provider credentials.

Existing local installs must be cleaned up manually as a one-time cutover: move
settings-owned values from `.env` into `settings.yaml`, remove raw
agent-accessed credentials from the runtime env file, and recreate those
credentials in the selected broker.

## Runtime-Owned Secrets

Runtime-owned secrets are needed to start and operate MyClaw or its connected
services. They are read through `RuntimeSecretProvider`.

Examples:

- `MYCLAW_DATABASE_URL`
- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- webhook secret
- control API secret
- `ONECLI_DATABASE_URL`
- `SECRET_ENCRYPTION_KEY`

Runtime-owned secrets are never injected into an agent runner. They are checked
by runtime preflight, doctor, channel setup, storage readiness, and broker
persistence readiness.

Runtime `.env` and process env are valid for these local/personal secrets. They
must not contain non-secret settings such as credential mode or broker URLs.

## Agent-Accessed Credentials

Agent-accessed credentials are credentials an agent may use after policy allows
the action. They include LLM provider access and tool or API credentials.

Agents do not receive raw secret values from MyClaw. Runtime code requests an
`AgentCredentialInjection` from `AgentCredentialBroker`; the returned injection
contains only broker-safe environment values, proxy references, and certificate
references.

Raw provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and
`CLAUDE_CODE_OAUTH_TOKEN` must be configured through OneCLI or the selected
enterprise credential broker, never in MyClaw `.env` or process env.

## Common Key Placement

| Value                                          | Source                                 |
| ---------------------------------------------- | -------------------------------------- |
| `credential_broker.mode`                       | `settings.yaml`                        |
| `credential_broker.onecli.url`                 | `settings.yaml`                        |
| `credential_broker.external.base_url`          | `settings.yaml`                        |
| `agent.default_model`                          | `settings.yaml`                        |
| `channels.slack.control_allowlist`             | `settings.yaml`                        |
| `storage.postgres.url_env`                     | `settings.yaml`                        |
| `MYCLAW_DATABASE_URL`                          | `RuntimeSecretProvider` / local `.env` |
| `TELEGRAM_BOT_TOKEN`                           | `RuntimeSecretProvider` / local `.env` |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`           | `RuntimeSecretProvider` / local `.env` |
| `ONECLI_DATABASE_URL`, `SECRET_ENCRYPTION_KEY` | `RuntimeSecretProvider` / local `.env` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`          | `AgentCredentialBroker`                |
| `CLAUDE_CODE_OAUTH_TOKEN`                      | `AgentCredentialBroker`                |

Legacy model env keys such as `ANTHROPIC_MODEL` and
`ANTHROPIC_DEFAULT_*_MODEL` are non-secret settings. Do not place them in
runtime `.env`; use `agent.default_model` for the default agent model and group
`/model` overrides for per-group model selection.

## Broker Profiles

`credential_broker.mode` supports:

- `onecli`: local/personal default using the OneCLI adapter.
- `none`: development mode with no broker injection.
- `external`: future enterprise-managed credentials.

The `external` profile is a placeholder contract. It does not include a Vault,
Kubernetes, AWS, GCP, Azure, or custom implementation yet.

Future Vault, Kubernetes Secrets, AWS Secrets Manager, GCP Secret Manager, Azure
Key Vault, or custom integrations must implement either `RuntimeSecretProvider`
for runtime-owned secrets or `AgentCredentialBroker` for agent-accessed
credentials. They must not add ad hoc runtime `.env` fallbacks for agent
credentials.

## OneCLI Adapter

OneCLI remains supported as the default personal broker. Its implementation
lives under `apps/core/src/adapters/credentials/onecli/`.

The adapter owns:

- `@onecli-sh/sdk` usage
- OneCLI URL validation
- broker-safe environment filtering
- OneCLI CA certificate materialization for host runners
- local OneCLI persistence readiness checks

The runtime calls the application credential service and receives a generic
`AgentCredentialInjection`; it does not instantiate OneCLI.

## Permission Boundary

Credential injection is not permission approval. Agent actions must still pass
through `PermissionPolicyService` before credentials are injected or used for a
tool/API action.

```mermaid
flowchart LR
  Runtime["Runtime agent run"] --> Policy["PermissionPolicyService"]
  Policy --> Broker["AgentCredentialBroker"]
  Broker --> Injection["AgentCredentialInjection"]
  Injection --> Runner["Agent runner env/proxy/cert refs"]
  Runtime --> Secrets["RuntimeSecretProvider"]
  Secrets --> RuntimeOnly["Runtime services only"]
```
