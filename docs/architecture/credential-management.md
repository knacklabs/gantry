# Credential Management

Gantry separates runtime-owned secrets, model gateway credentials, and
capability environment secrets projected to installed skills, MCP servers, and
tools.

## Source Lanes

Gantry uses four source lanes:

- `settings.yaml` stores non-secret configuration, such as model gateway
  mode, channel enablement, schemas, allowlists, and model selections.
- `RuntimeSecretProvider` resolves runtime-owned secrets. The local/personal
  implementation reads runtime `.env` and process env for values such as
  database URLs, channel bot tokens, webhook/control secrets, and the stable
  credential encryption key.
- Gantry Credential Center stores capability env var values for selected skills, MCP
  servers, and reviewed tools. Values are encrypted in Postgres and projected
  only when a selected capability declares the matching env var or credential
  ref.
- `AgentCredentialBroker` resolves model-provider access and broker-safe model
  adapter injections such as loopback provider gateway URLs and run-local
  gateway tokens. Model credentials must not be reused as tool env.

There is no global `.env > database > broker` precedence. Precedence is
lane-specific: settings choose behavior, runtime secret providers resolve
runtime secrets, capability credentials resolve capability env vars, and model
credentials come from the Gantry Model Gateway. If a value appears in the wrong lane,
Gantry reports it as a configuration error instead of silently ignoring or
overriding it.

Wrong-lane checks apply to both runtime `.env` and the process environment used
to start Gantry. Process env may override local `.env` only inside
runtime-secret resolution; it is not ambient agent tool env. If a local shell
already has a capability secret, import it explicitly with
`gantry credentials access import-env NAME`.

## Runtime-Owned Secrets

Runtime-owned secrets are needed to start and operate Gantry or its connected
services. They are read through `RuntimeSecretProvider`.

Examples:

- `GANTRY_DATABASE_URL`
- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- webhook secret
- control API secret
- `SECRET_ENCRYPTION_KEY`
- `SECRET_ENCRYPTION_KEYRING_JSON`

Runtime-owned secrets are never injected into an agent runner. They are checked
by runtime preflight, doctor, channel setup, storage readiness, and credential
encryption readiness.

Runtime `.env` and process env are valid for these local/personal secrets. They
must not contain non-secret settings such as model access state or gateway URLs.

## Capability Credentials

Capability credentials are the central store for simple env-var-shaped secrets
needed by approved agent capabilities. They are encrypted with
the Gantry credential secret envelope in Postgres and are never written to
`settings.yaml`. The envelope format is `gcred:v2:<key-id>:...` and uses
AES-256-GCM with metadata-bound AAD. Operator-pasted values that look like an
envelope are still encrypted as plaintext input; there is no prefix passthrough.

`SECRET_ENCRYPTION_KEY` may hold one active base64-encoded 32-byte key. For
rotation, use `SECRET_ENCRYPTION_KEYRING_JSON` with an `active` key id and a
`keys` object of key-id to base64 key values. New writes use the active key;
reads can decrypt any configured key id in the keyring.

Examples:

- `GITHUB_TOKEN` for a GitHub MCP server
- `LINKEDIN_ACCESS_TOKEN` for a LinkedIn posting skill
- `GOOGLE_APPLICATION_CREDENTIALS_JSON` for a reviewed local tool that expects
  an env var

CLI management:

```bash
gantry credentials access list
gantry credentials access set LINKEDIN_ACCESS_TOKEN
gantry credentials access import-env GITHUB_TOKEN
gantry credentials access unset GITHUB_TOKEN
```

These are host/admin CLI commands. Agent runs must not execute
`gantry credentials ...`, read `settings.yaml`, or write runtime credential
state directly. When a skill/MCP/local-CLI credential is missing, the agent
reports `Setup required: credential missing: NAME` and waits for a human or
approved admin surface to set the value in Credential Center.

Agents do not edit `.env`, `settings.yaml`, skill directories, or MCP config to
manage these values. When a selected skill or MCP server needs a missing secret,
the runtime fails closed with `gantry credentials access set NAME`
guidance. If the value already exists in the host shell, an admin can run
`gantry credentials access import-env NAME` to move it into the central
store.

Skill action manifests declare required env-var names and scoped commands; they
must not instruct agents to set shell env vars inline. Runtime injects approved
skill secrets and neutral CA trust aliases for approved tool calls, so skill
commands should stay argv-shaped, such as
`python3 skills/linkedin-posting/post.py --file ...`.

## Agent-Accessed Credentials

Agent-accessed credentials are credentials an agent may use after policy allows
the action. They include LLM provider access and tool or API credentials, but
those two categories are not scoped the same way. Model-provider credentials
come from the Gantry Model Gateway. Tool env vars come from capability
credentials when a selected
capability declares a need. Reviewed `local_cli` capabilities are valid when
the CLI already owns its own authenticated account state and Gantry pins the
executable, command templates, preflight, protected paths, and denied
environment overrides before projecting scoped command authority.

Model-provider access is account-level Model Access. Gantry always requests it
with `purpose=model_runtime` through the Gantry Model Gateway; it is not bound
to an individual agent, conversation, memory worker, subagent, or job. Agents,
subagents, jobs, and memory workers select catalog model aliases only.
Anthropic, OpenRouter, and OpenAI embedding credentials are configured once
with `gantry credentials model set anthropic`,
`gantry credentials model set openrouter`, or
`gantry credentials model set openai`,
`gantry credentials model set bedrock`, or
`gantry credentials model set vertex` and then projected through the Gantry
Model Gateway according to the selected model provider or embedding provider.
Each provider exposes explicit credential modes through the control API as
`credentialModes`; Anthropic supports `api_key` and `claude_code_oauth`, while
OpenRouter and OpenAI use `api_key`, Amazon Bedrock uses `bedrock_api_key`, and
Google Vertex AI uses `service_account`. `PUT
/v1/credentials/models/:providerId` replaces a credential and selects the auth
mode, `PATCH` rotates fields for the existing auth mode, and all read/mutation
responses return only redacted status, fingerprints, configured field names,
and mode metadata.

The active credential modes follow from the model's provider and selected
agent harness. The agent harness contract is recorded in
`docs/decisions/2026-06-14-agent-harness-selection.md`. `agentHarness` is
durable user/admin intent with values `auto`, `anthropic_sdk`, and
`deepagents`; in `settings.yaml`, the key is `agent_harness`. `auto` derives the
internal execution lane from the model provider, while explicit
`anthropic_sdk` or `deepagents` is honored only when the selected model is
compatible and otherwise fails before runner spawn:

| provider             | `auto` harness lane | compatible explicit `agentHarness` | credential modes                |
| -------------------- | ------------------- | ---------------------------------- | ------------------------------- |
| `anthropic` (Claude) | `anthropic_sdk`     | `anthropic_sdk`                    | `api_key` + `claude_code_oauth` |
| `openai`             | `deepagents`        | `deepagents`                       | `api_key`                       |
| `openrouter`         | `deepagents`        | `deepagents`                       | `api_key`                       |
| `bedrock`            | `deepagents`        | `deepagents`                       | `bedrock_api_key`               |
| `vertex`             | `deepagents`        | `deepagents`                       | `service_account`               |

Anthropic SDK is the only Claude OAuth/subscription lane and also runs Anthropic
API-key models. DeepAgents is the OpenAI-compatible harness for OpenAI,
OpenRouter, Bedrock, and Vertex routes through the Gantry Model Gateway and
cannot use Claude OAuth/subscription credentials. Bedrock API-key mode forwards
to the regional `bedrock-runtime.<region>.amazonaws.com/openai/v1` endpoint;
AWS credentials, SigV4, and default-chain identity are deferred for a separate
non-OpenAI Bedrock API-family lane. Vertex `service_account` mode mints a
host-side OAuth token for the global Vertex OpenAI-compatible endpoint.
Bedrock API keys, service-account JSON, and minted OAuth tokens are never
projected to the runner.
`agentHarness: auto` derives from the provider and explicit harness choices are validated before
runner spawn so incompatible model/harness pairings fail before any model SDK
process starts. A defensive backstop at the credential boundary still
guarantees a Claude OAuth/subscription credential can only ever project to the
Anthropic SDK lane; the DeepAgents lane fails closed if it ever resolves one
(`DeepAgents cannot use Claude OAuth/subscription credentials. Choose Anthropic SDK or configure Claude API-key Model Access.`).
DeepAgents runner authority remains Gantry-owned and wrapped: raw `execute`, raw
local filesystem access, raw `.mcp.json`, and raw provider credentials are not
projected to the runner.

Host-side memory (extraction, dreaming, consolidation) has no engine selector
either (the retired `memory.engine` key is rejected at settings validation). The
memory transport lane is derived at query dispatch
(`route-aware-memory-llm-client.ts`): an Anthropic-family memory model uses the
Claude Agent SDK memory client; an OpenAI-family memory model uses the
OpenAI-compatible direct chat-completions client. Provider takes precedence over
the nominal family — OpenRouter's nominal response family is `anthropic`, but
because it runs on the DeepAgents/OpenAI-compatible engine it dispatches to the
OpenAI-compatible client (over the brokered OpenRouter gateway projection). A
deployment that selects OpenAI/OpenRouter memory model aliases runs memory with no
Anthropic models at all.

Agents do not receive every raw secret value from Gantry. Runtime code projects
only the selected capability's declared credential names. Attached skills do
not receive secrets by being attached; a selected reviewed skill action must
declare the matching `requiredEnvVars` before those values are projected.
Selected MCP servers get only their reviewed credential refs; reviewed tools get
only their declared env needs. Model credential injection remains broker-owned
and must never be reused for tool env.

For local authenticated CLIs, Gantry does not copy raw OAuth tokens or broker
proxies into generic Bash. The approved semantic capability maps to narrow
scoped command templates and protected credential/config paths. User-defined
local CLI capabilities require pinned executable identity, version/hash, auth
preflight, protected paths, and denied environment overrides before runtime
projects scoped command authority. Agents may not override
token, credential file, config directory, proxy, keychain/keyring, CA, or
authority environment keys unless a future capability explicitly models that
behavior.

Selected `local_cli` capabilities project credential paths and network host
metadata only through typed runtime access. Credential directories are mounted
into the SDK as additional readable directories and are also added to
`sandbox.filesystem.denyWrite`; they are intentionally not added to
`denyRead`. Declared network hosts are not durable `SandboxNetworkAccess`
authority. For scheduled jobs, Gantry may suppress a parentless SDK network
prompt only when it arrives immediately after the same principal's approved
Bash invocation, that command matches the reviewed local CLI command template,
and the requested host matches the capability's declared host list.

Raw provider credentials such as `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock API keys, AWS access keys,
and Vertex service-account JSON must be configured through Gantry model
credentials, never in Gantry `.env` or process env.

## Common Key Placement

| Value                                                         | Source                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `model_access.enabled`                                        | `settings.yaml` advanced override                       |
| `model_access.gateway.bind_host`                              | `settings.yaml` advanced override                       |
| `agent.name`                                                  | `settings.yaml`                                         |
| `agent.default_model`                                         | `settings.yaml`                                         |
| `agent.one_time_job_default_model`                            | `settings.yaml`                                         |
| `agent.recurring_job_default_model`                           | `settings.yaml`                                         |
| `memory.llm.models.*`                                         | `settings.yaml`                                         |
| Conversation approvers                                        | `settings.yaml` and Postgres conversation approver rows |
| `storage.postgres.url_env`                                    | `settings.yaml` advanced override                       |
| `GANTRY_DATABASE_URL`                                         | `RuntimeSecretProvider` / local `.env`                  |
| `TELEGRAM_BOT_TOKEN`                                          | `RuntimeSecretProvider` / local `.env`                  |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`                          | `RuntimeSecretProvider` / local `.env`                  |
| `SECRET_ENCRYPTION_KEY`                                       | `RuntimeSecretProvider` / local `.env`                  |
| Skill, MCP, and reviewed tool env vars                        | Gantry Credentials (`gantry credentials access ...`)    |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` | Gantry model credentials                                |
| `CLAUDE_CODE_OAUTH_TOKEN`                                     | Gantry model credentials                                |

Planned key placement after parser/API/CLI support lands:
`defaults.agent_harness` and `agents.<id>.agent_harness` will live in
`settings.yaml` as non-secret user/admin intent. They are not accepted by the
current parser.

Model env keys such as `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, and
`ANTHROPIC_DEFAULT_*_MODEL` are child-process adapter projections. Gantry
runtime config does not accept them from runtime `.env`; use provider-neutral
aliases through `agent.default_model`, `agent.one_time_job_default_model`,
`agent.recurring_job_default_model`, `memory.llm.models.*`, `gantry model`, the
Control API defaults route, and group `/model` overrides for model selection.
OpenRouter is selected by provider or catalog alias. The current OpenRouter
adapter projection uses a Claude Agent SDK-compatible loopback gateway endpoint
with `gtw_*` tokens supplied by `AgentCredentialBroker`; the child process never
receives the upstream OpenRouter API key or direct OpenRouter base URL.

## Model Access Modes

`model_access.enabled` supports:

- `true`: local/personal default using encrypted Postgres model credentials and
  a loopback model gateway.
- `false`: development mode with no model gateway injection.

Future Vault, Kubernetes Secrets, AWS Secrets Manager, GCP Secret Manager,
Azure Key Vault, or custom integrations must implement typed repositories or
providers behind Gantry Credential Center. They must not add ad hoc runtime
`.env` fallbacks for agent credentials.

## Gantry Model Gateway

The Gantry Model Gateway is the only active local model credential path. It
stores provider credentials in `model_credentials` rows encrypted with
the same `gcred:v2` metadata-bound envelope, stores the selected provider
`authMode` as non-secret metadata, exposes redacted status through the Control
API and
`gantry credentials model status`, and serves per-run loopback HTTP endpoints
for Anthropic, OpenRouter, OpenAI embedding, Bedrock, and Vertex traffic.

Provider credential shape is owned by the model provider registry. Each
provider declares one or more credential modes with:

- stable mode id, label, and help text
- user-facing field labels such as `Anthropic key`, `Azure endpoint`,
  `Deployment name`, and `AWS region`
- required field metadata
- a gateway auth strategy

OpenRouter and OpenAI each expose one `api_key` mode, so setup stays direct.
Anthropic exposes `api_key` for direct API keys and `claude_code_oauth` for
Claude Code subscription OAuth tokens. Bedrock exposes `bedrock_api_key`
(`region` + secret key) for the OpenAI-compatible Chat Completions route.
AWS credential, SigV4, and default-chain modes require a separate Bedrock API
family route and are not advertised as active support here. Vertex exposes
`service_account` (`region`, `projectId`, and service-account JSON). The
service account's owner `project_id` may differ from the target `projectId`
when IAM allows that identity to call Vertex in the target project. Providers
that need more than one path, such as Azure Foundry, add additional modes in
the registry instead of adding CLI, API, storage, or gateway branches.

All user-entered credential and provider configuration values stay in the
encrypted structured payload. Read surfaces return only provider label, role,
workloads, selected `authMode`, credential modes, field metadata, configured
field names, fingerprints, health, and timestamps.

Gateway tokens are app-scoped, run-scoped, provider-scoped, and bound to the
credential fingerprint, `authMode`, and schema version present at token issue.
Credential disable or rotation invalidates previously issued tokens instead of
letting them reuse newer secrets. Gateway requests are POST-only, path-confined
under the provider route and upstream prefix, size-limited, timeout-bound, and
proxied through request/response header allowlists.

Control API semantics:

- `GET /v1/credentials/models` returns redacted admin-UI-ready status for all
  supported providers.
- `PUT /v1/credentials/models/:providerId` fully replaces one provider
  credential and may set or change `authMode`.
- `PATCH /v1/credentials/models/:providerId` rotates fields inside the
  existing active `authMode`; omitted fields are preserved, while empty, null,
  unknown, missing, disabled, or auth-mode-changing updates are rejected.
- `DELETE /v1/credentials/models/:providerId` disables active use without
  deleting the encrypted payload or metadata.

Gateway auth strategies are fail-closed. Current `header`, `bearer`,
`claude_code_oauth`, `aws_bedrock_api_key`, `aws_sigv4`, and
`vertex_service_account` strategies inject or mint credentials at the outbound
provider boundary. `aws_sigv4` remains a host gateway strategy for future
non-OpenAI Bedrock API-family work, but the active OpenAI-compatible Bedrock
provider does not expose an `access_key` mode. Future strategies such as
`aws_sdk_default_chain`, `azure_api_key`, and `azure_entra_default_credential`
are distinct strategy slots; they must not fall through to generic header
injection. Runner-supplied provider auth headers are stripped before the
gateway adds Bedrock or Vertex headers.

AWS Bedrock API keys are bearer-token style Bedrock credentials. Static
IAM/SigV4 mode for Bedrock's non-OpenAI APIs is deferred; it must not be
treated as compatible with the OpenAI SDK Chat Completions route. Ambient AWS
default-chain identity is also deferred. Azure OpenAI/Foundry API-key mode
needs endpoint, deployment, and key fields; Azure Entra mode uses bearer tokens
produced from local or hosted identity, so onboarding explains the required
identity and runs readiness checks instead of asking for a token.

### Bedrock and Vertex first cut

The current Bedrock and Vertex strategy is intentionally narrow:

- Bedrock ships only the OpenAI-compatible `bedrock-oss` catalog alias, routed
  to `openai.gpt-oss-120b-1:0` through Amazon Bedrock OpenAI Chat
  Completions. That OpenAI-compatible route authenticates only with an Amazon
  Bedrock API key and uses the regional
  `bedrock-runtime.<region>.amazonaws.com/openai/v1` base URL. Claude on
  Bedrock and AWS credentials/SigV4/default-chain authentication are deferred to
  a separate non-OpenAI Bedrock API-family lane.
- Vertex ships the `vertex` and `vertex-flash-3.5` aliases, routed to
  `google/gemini-3.5-flash` through the Vertex OpenAI-compatible endpoint.
  The current route accepts only `global`. Gantry's gateway uses the
  documented OpenAI-library
  `https://aiplatform.googleapis.com/v1`
  `/projects/{project}/locations/{location}/endpoints/openapi/chat/completions`
  path. Credentialed live smoke testing remains required before treating the
  external endpoint choice as fully proven. Regional and multi-region Vertex
  routing is deferred until explicitly implemented and verified; do not claim
  `us` or `eu` support in the current OpenAI-compatible lane.
  Older Vertex Flash 2.0 aliases are not valid because that model is
  discontinued.
- Vertex service-account JSON must have the expected service-account shape,
  but the service-account owner `project_id` is not required to equal the
  target Vertex `projectId`. If the uploaded JSON omits `token_uri`, Gantry
  pins token exchange to `https://oauth2.googleapis.com/token`; if `token_uri`
  is present with any other value, the gateway rejects the credential before
  token minting.
- The DeepAgents runner still receives only the loopback provider base URL and
  a run-scoped `gtw_` token. Bedrock API keys, Vertex service-account JSON, and
  minted OAuth tokens stay inside the host gateway.

Example Control API payloads:

```json
{
  "authMode": "bedrock_api_key",
  "payload": {
    "region": "us-east-1",
    "apiKey": "bedrock-key"
  }
}
```

```json
{
  "authMode": "service_account",
  "payload": {
    "region": "global",
    "projectId": "gantry-project",
    "serviceAccountJson": "{\"type\":\"service_account\",\"project_id\":\"gantry-project\",\"client_email\":\"...\",\"private_key\":\"...\"}"
  }
}
```

Surface Impact Matrix:

| surface                      | classification       | reason                                                                                                                                                 |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| runtime behavior             | Changed              | The model gateway resolves Bedrock/Vertex upstream origins dynamically from stored credential payloads and injects provider-specific auth host-side.   |
| `settings.yaml`              | Unchanged by design  | Provider credentials, region, and project stay out of settings; users select existing catalog aliases through the existing model fields.               |
| Postgres/runtime projection  | Changed              | Existing `model_credentials` rows now store Bedrock/Vertex auth mode plus encrypted structured payload fields.                                         |
| control API                  | Changed              | Existing credential routes expose Bedrock/Vertex provider metadata, accepted auth modes, validation, and redacted status without a route-shape change. |
| SDK/contracts                | Unchanged by design  | The runner contract remains provider id + provider model id + loopback gateway URL + `gtw_` token; raw provider secrets are not projected.             |
| CLI                          | Changed              | Existing `gantry credentials model set/status` surfaces now display Bedrock/Vertex provider modes and field prompts from the registry.                 |
| Gantry MCP tools/admin skill | Unchanged by design  | No new admin tool is introduced; existing approved settings/credential surfaces apply.                                                                 |
| channel/provider adapters    | Read-only/observable | Channels render the same approvals/receipts and gain no channel-specific authority; model provider gateway behavior is covered under runtime behavior. |
| docs/prompts                 | Changed              | README, credential architecture, and DeepAgents adapter instructions describe the bounded provider contract and deferred Claude-on-Bedrock path.       |
| audit/events                 | Read-only/observable | Existing credential and gateway events carry the new provider ids and auth modes; no new event type is required.                                       |
| tests/verification           | Changed              | Catalog, credential validation, gateway routing/auth, registry validation, and log-redaction tests cover the new provider paths and negative cases.    |

Deferred decisions:

- Bedrock Claude support requires official and live proof that the target model
  supports Bedrock Chat Completions on the intended endpoint, or a separate
  Bedrock Anthropic Messages/Converse runtime lane. It must not be represented
  as OpenAI compatible without that proof.
- Ambient AWS default-chain identity, Vertex ADC/workload identity, runtime
  provider model discovery, regional model availability checks, and credentialed
  Bedrock/Vertex live smoke automation are separate changes with their own
  docs/tests.
- Provider live smoke tests require real Bedrock and Vertex credentials. Local
  verification can prove Gantry routing, credential containment, request
  signing, and token minting behavior, but not external account entitlement.

For every model auth mode, the selected model runner receives only its
adapter-owned loopback gateway env and a short-lived `gtw_*` token. The gateway
swaps that token for the stored provider credential only at the outbound
provider boundary. Bash tools, MCP stdio subprocesses, browser tools, and skills
do not receive model provider keys or provider OAuth tokens.

`NO_PROXY` and `no_proxy` are compatibility hints for cooperative tools, not an
authorization boundary. Approved tool subprocesses receive egress proxy and
neutral trust settings through provider-neutral `toolNetworkEnv`; model gateway
credentials stay in `modelCredentialEnv`. A malicious or vulnerable tool can
ignore environment variables, so protection still comes from capability
selection, permission policy, sandbox policy, egress denylist/private-network
checks, and audit.

The runtime calls the application credential service and receives a generic
`AgentCredentialInjection`; it does not read provider keys directly.

The model gateway never executes tools, approves permissions, owns scheduler
policy, evaluates protected capability changes, or enforces egress policy.
Model credential env is passed only to the Claude SDK process private model
credential handoff. Bash tools, MCP stdio subprocesses, browser tools, and
skills do not receive model provider tokens. Host-owned scheduler scripts are
not supported.

The SDK process receives sandbox policy and model credentials as separate
adapter projections. Approved tool calls receive a separate `toolNetworkEnv`
projection for the Gantry loopback egress proxy and neutral TLS aliases; future
execution adapters such as Deep Agents must consume that same neutral contract
instead of reusing model credentials for tool egress. Protected filesystem paths
are passed through
`GANTRY_PROTECTED_FILESYSTEM_DENY_READ_PATHS_JSON` and
`GANTRY_PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_JSON` and become Claude SDK
`sandbox.filesystem.denyRead` and `sandbox.filesystem.denyWrite` entries;
reviewed local CLI credential directories are also passed through
`GANTRY_LOCAL_CLI_CREDENTIAL_DIRS_JSON` so the SDK can mount them for reads
while still denying writes. Model credentials remain only in the private SDK env
handoff. Do not use MCP stdio env, browser env, or any future scheduler script
env to carry sandbox authority or provider credentials.

## Permission Boundary

Credential injection is not permission approval. Agent actions must still pass
through `ToolExecutionPolicyService` and the permission/capability binding
checks before credentials are injected or used for a tool/API action.

```mermaid
flowchart LR
  Runtime["Runtime agent run"] --> Policy["ToolExecutionPolicyService"]
  Policy --> CapabilitySecrets["Capability Credentials"]
  CapabilitySecrets --> CapabilityEnv["Selected skill/MCP/tool env"]
  Runtime --> Broker["Gantry Model Gateway"]
  Broker --> ModelInjection["Private model SDK credential handoff"]
  Runtime --> Secrets["RuntimeSecretProvider"]
  Secrets --> RuntimeOnly["Runtime services only"]
```
