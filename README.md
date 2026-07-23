# Gantry

Gantry is a self-hosted, provider-neutral agent runtime for teams that run AI
agents in production — in the channels where the team already works and inside
their own products via SDK and API. It gives agents a controlled host process,
durable state, approved tools, channel adapters, memory, and audit records
without tying application code to one model provider or chat surface.

Gantry is not a chatbot wrapper and not a personal assistant. It is the
runtime boundary between:

- human channels such as Slack, Microsoft Teams, Telegram, Discord, and
  web/SDK clients;
- application events, SDK calls, and scheduled jobs;
- approved tools, local CLIs, browser automation, skills, and MCP servers;
- Postgres-backed runtime state, artifacts, settings, credentials, and audit.

What that buys a team in practice:

- **Governed autonomy.** Capability grants, declarative per-agent `tool_rules`,
  an optional LLM auto-permission mode that relieves prompt fatigue without
  ever writing policy by itself, and one-tap durable approvals — every
  decision audited.
- **Fleet operations.** Multiple agents across conversations and channels,
  scheduled jobs with delivery guarantees, sandboxed worker and lightweight
  inline runtimes, and versioned desired-state settings.
- **Developer surface.** A typed Node SDK generated from the OpenAPI doc,
  lifecycle webhooks, a `/v1/usage` API, a provider-shaped direct LLM API, and
  runnable NestJS/Next.js examples.
- **Institutional memory.** Per-agent and shared memory with review flows, so
  what agents learn stays inspectable and survives model or provider swaps.

## Status

This repository is being prepared as an open-source project. The intended npm
package shape is:

- `@gantry/runtime` for the runtime and `gantry` CLI binary
- `@gantry/sdk` for the Node.js SDK
- `@gantry/contracts` for shared TypeScript contracts

Until the first public package publish, build and run from source.

## Requirements

- Node.js `>=24 <26`
- npm
- Postgres for runtime state
- `ripgrep`
- For `sandbox_runtime` on Linux: `bubblewrap` and `socat`

Ubuntu prerequisites:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git libatomic1 bubblewrap socat ripgrep
```

## Quick Start From Source

```bash
git clone https://github.com/cawstudios/Agent.Gantry.git
cd Agent.Gantry
npm ci
npm run build
```

Create a local runtime environment:

```bash
cp .env.example .env
```

Edit `.env` with a local-only Postgres URL and generated secrets. The example
database password is for loopback development only; do not reuse it in hosted
or production deployments.

Start Gantry:

```bash
npm start
```

For CLI development:

```bash
npm link
gantry doctor
gantry status
```

## Runtime Configuration

Runtime home defaults to `~/gantry` unless `GANTRY_HOME` or `--runtime-home` is
set. Human-readable settings live in `~/gantry/settings.yaml`; the durable
desired-state authority is the latest Postgres `settings_revisions` row.

Runtime secrets belong in `<GANTRY_HOME>/.env` or a runtime secret provider.
Model/provider credentials must be configured through Gantry credentials and
the Gantry Model Gateway. Do not pass raw model provider keys directly to agent
processes.

Common local commands:

```bash
gantry setup
gantry doctor
gantry status
gantry start
gantry stop
gantry restart
gantry logs
gantry model list
gantry provider list
gantry settings validate
```

Bundled runtime surfaces:

- `/commands` is host-managed command help, not an SDK skill folder.
- `gantry-admin` is the maintainer skill for local runtime administration.

### Local Web UI linkage

The built React application is served by the Gantry process at `/ui/`.
Production and remote deployments remain disconnected by default. For a local
workstation runtime only, add a dedicated Control key to
`GANTRY_CONTROL_API_KEYS_JSON` and set:

```dotenv
NODE_ENV=development
GANTRY_PROCESS_ROLE=all
GANTRY_CONTROL_HOST=127.0.0.1
GANTRY_CONTROL_PORT=3939
GANTRY_UI_LOCAL_OWNER_ENABLED=true
GANTRY_UI_LOCAL_OWNER_KEY_ID=ui-local-owner
```

The `ui-local-owner` key needs these scopes:

```text
sessions:read, sessions:write, jobs:read, jobs:write,
memory:read, memory:admin, conversations:read, conversations:admin,
messages:read, providers:read, agents:admin,
credentials:read, credentials:admin, usage:read
```

After `npm run build` and `gantry restart`, open
`http://127.0.0.1:3939/ui/`. Gantry attaches the dedicated key internally to
allowlisted `/ui-api/v1/*` requests; its bearer token is never returned to or
stored by the browser. Startup fails if this mode is enabled under a
production/remote posture, non-loopback host, worker role, or reduced Control
route profile.

## Execution Surfaces

Gantry exposes three ways to run model work, all under the same permission,
credential, and audit authority:

- **Worker agents** (`runtime: worker`, the default) run in a sandboxed
  subprocess with the full reviewed capability projection: filesystem, shell,
  skills, browser automation, and stdio MCP servers.
- **Inline agents** (`runtime: inline`) run the provider loop in the Gantry
  host process for lightweight chat-style workloads: core tools, remote
  `http`/`sse` MCP servers, subagent delegation, scheduled jobs, per-agent turn
  caps, and per-message structured output (`response_schema`).
- **Direct LLM API** (`POST /llm/v1/messages`, `POST /llm/v1/chat/completions`)
  is a provider-shaped passthrough for raw model calls with Gantry-held
  credentials — point an official Anthropic or OpenAI SDK at Gantry via its
  `baseURL` option and authenticate with a Control API key holding
  `llm:invoke`.

See [docs/architecture/capability-management.md](docs/architecture/capability-management.md)
for runtime tiers and the LLM API contract.

## SDK

The Node SDK talks to the Control API over a Unix socket or HTTP endpoint.

```bash
npm i @gantry/sdk
```

```ts
import { createClient } from '@gantry/sdk';

const client = createClient({
  apiKey: process.env.GANTRY_CONTROL_API_KEY!,
  baseUrl: 'http://127.0.0.1:3939',
});

const health = await client.health();
console.log(health.status, health.processRole);
```

See [packages/sdk](packages/sdk/README.md) and
[examples/control-api-local](examples/control-api-local/README.md).

## Security Model

Gantry treats model output, provider SDKs, workers, browser backends, MCP
servers, and local tools as untrusted execution surfaces. Risky tool execution
passes through Gantry-owned permission policy, sandbox policy, credential
brokering, and audit.

Public deployments should expose only the routes they need:

- `/v1/*` is the authenticated Control API and should be restricted to trusted
  admin or application networks.
- `/webhooks/*` is for provider webhook ingress when enabled.
- `/healthz`, `/readyz`, and `/metrics` are operational endpoints and must stay
  internal.

For details, read [docs/SECURITY.md](docs/SECURITY.md) and
[docs/architecture](docs/architecture/README.md).

## Development

Tests and harnesses live outside production source trees:

- `apps/core/test/unit/**`
- `apps/core/test/integration/**`
- `apps/core/test/e2e/**`
- `apps/core/test/harness/**`
- `packages/contracts/test/unit/**`

Common checks:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run security:package
```

Postgres-backed integration tests require a disposable Postgres database via
`GANTRY_TEST_DATABASE_URL`; do not run them against a developer's persistent
runtime database.

## Optional Codex Factory

The `.agents/`, `.codex/`, and `.factory/` folders contain optional maintainer
automation for planning, decomposition, verification, and review. Public
contributors are not required to use it. Maintainers who enable the harness
should first read [AGENTS.md](AGENTS.md), [WORKFLOW.md](WORKFLOW.md),
[docs/FACTORY.md](docs/FACTORY.md), and [docs/QUALITY.md](docs/QUALITY.md).

## Documentation

- [Product brief](docs/product/BRIEF.md)
- [Architecture docs](docs/architecture/README.md)
- [Decision records](docs/decisions/README.md)
- [SDK docs](docs/sdk/overview.md)
- [Deployment docs](docs/deployment/aws-terraform.md)

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Keep
changes small, current-behavior focused, and backed by the smallest relevant
checks.

## License

MIT. See [LICENSE](LICENSE).


## Working in this repo — Symphony Forge

This repo runs on the [Symphony Forge](https://github.com/knacklabs/symphony-forge)
engineering harness: agents do the mechanical work, deterministic gates keep
the evidence honest, and humans make the decisions. Getting started is
conversational — open an agent session (Claude Code or Codex) in the repo
root, then:

- **The session checks your machine every time.** If tools are missing it
  says so on the spot — reply "set up my machine" and approve the installs;
  only logins stay manual.
- **Ask "what now?" whenever you are unsure.** The harness answers with the
  current phase and the exact next step. There is nothing to memorize.
- **Every feature starts with a plan the agent must defend.** Plan mode is
  enforced by hooks; work then runs stage by stage with a local review
  before every commit, and shipping refuses until the evidence gates pass.
- **The map:** `AGENTS.md` is the contract and read order, `WORKFLOW.md` the
  doctrine, `docs/product/BRIEF.md` what this product is. Standards that are
  law live in `docs/architecture/` and `docs/decisions/`.
- **Humans own** accepting decisions, client sign-off, and merging PRs —
  agents draft and relay, never run those.

The vendored harness machinery (`.agents/`, `constitution/`, gate scripts)
is frozen: never edit it here — improvements go to the harness repo and
arrive by re-vendoring.
