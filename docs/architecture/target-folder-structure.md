# Target Folder Structure

This document defines the source layout Gantry should converge on while moving
from the current implementation to the canonical platform architecture. It is a
target for future code movement, not a statement that the repository already
fully matches the layout.

## Target Top-Level Source Layout

```text
apps/core/src/
  domain/
  application/
  runtime/
  adapters/
  config/
  shared/

packages/
  contracts/
  sdk/
```

The target layout is intentionally small. Do not create broad `common`, `misc`,
or `utils` buckets. Shared code must have a clear owner and narrow purpose.

## Dependency Direction

Allowed direction:

```text
adapters -> application -> domain
runtime -> application -> domain
control-http -> application -> domain
cli -> application -> domain
```

Layer rules:

- `domain` imports no adapters, runtime, CLI, HTTP, Postgres, Slack, Telegram,
  Teams, WhatsApp, Claude, Anthropic SDK, OpenAI, Gemini, ACP/ACPX, or
  provider-specific packages.
- `application` may import domain entities, domain services, ports, and shared
  contracts. It must not instantiate concrete adapters.
- `runtime` may compose application services into queues, runs, leases, IPC,
  process supervision, and lifecycle management. Provider-specific branching
  belongs in adapters.
- `adapters` implement ports for external systems and may depend on SDKs,
  frameworks, databases, credential brokers, channel APIs, and model providers.
- `control-http` and `cli` are adapter families. They should parse requests and
  call application use cases.
- `config` parses runtime settings and secret source selection. It must fail
  loudly for wrong-lane credentials.
- `shared` is for small dependency-light helpers with stable ownership, such as
  time, object handling, and path-safe utilities. It is not a dumping ground.

## Directory Responsibilities

### `domain/`

Owns provider-free and channel-free product concepts:

- app, agent, config version, model profile
- provider connection and binding abstractions without provider SDK types
- conversation, thread, user, message, message part, attachment metadata
- session, provider session reference, run, run event
- memory subject, job
- tool and skill catalog items
- permission policy, rule, and decision
- sandbox profile and lease
- workspace snapshot and browser profile identity
- repository and service ports

Domain code should be testable without Node process globals, network access,
provider credentials, or a database.

### `application/`

Owns use cases and policy orchestration:

- create and configure apps and agents
- install channels and bind agents to conversations
- ingest normalized messages
- create sessions and runs
- evaluate permissions
- request sandbox leases
- manage memory subjects and job lifecycles
- route control API, CLI, SDK, Web UI, and channel actions into domain behavior

Application services depend on ports for storage, channel delivery, LLM
providers, credential brokers, sandboxes, browser profiles, and event sinks.

### `runtime/`

Owns long-running process behavior:

- bootstrap and lifecycle coordination
- message and job queues
- agent run supervision
- continuation input and cancellation
- IPC and MCP hosting where needed
- sandbox lease activation
- workspace snapshot materialization
- browser profile process management
- graceful shutdown and recovery

Runtime should coordinate use cases. It should not define business rules that
only CLI, control HTTP, or channel adapters can reach.

### `adapters/`

Owns concrete integrations:

- channel adapters: Telegram, WhatsApp, Slack, Teams, Web UI, SDK app channel
- LLM adapters: Claude/Anthropic, OpenAI, Gemini, local providers
- credential adapters: OneCLI, external broker, runtime secret providers
- storage adapters: Postgres, pg-boss, migrations, search indexes
- control HTTP adapter
- CLI adapter
- browser and sandbox providers
- ACP/ACPX orchestration adapters
- logging, service-manager, and platform adapters

Adapters translate external payloads into canonical application inputs and
translate canonical outputs back to external surfaces.

### `config/`

Owns runtime configuration parsing and validation:

- `settings.yaml` parsing and rendering
- runtime-owned secret source classification
- non-secret defaults
- wrong-lane credential rejection
- preflight checks that do not require concrete application behavior

New config values must be classified before implementation:

- non-secret runtime configuration belongs in `settings.yaml`
- runtime-owned secrets belong behind `RuntimeSecretProvider`
- agent-accessed credentials belong behind `AgentCredentialBroker`

### `shared/`

Owns narrow helpers that are safe for multiple layers to depend on. Shared
helpers must not import provider SDKs, runtime lifecycle code, CLI, control
HTTP, or Postgres.

Acceptable examples:

- pure object helpers
- time formatting primitives
- identifier normalization
- path validation primitives

Unacceptable examples:

- provider-specific helpers
- business workflows
- persistence shortcuts
- broad utility modules

## Packages

### `packages/contracts/`

Owns published and internal shared contracts:

- request and response schemas
- event shapes
- SDK-safe value types
- versioned public API contracts

Contracts must not expose internal database rows, provider SDK payloads, or
runtime-only implementation details.

This package is the integration boundary for control API clients, the
server-side SDK, Web UI applications, and external NestJS/NextJS integrations.
Those consumers should import DTOs and schemas from `@gantry/contracts`, not
from runtime, adapters, Postgres, channel, or provider-specific source paths.

### `packages/sdk/`

Owns the server-side SDK over the control API:

- typed client methods
- streaming helpers
- wait and webhook helper behavior
- SDK documentation examples

The SDK must not import runtime internals. It talks to the control API using
contracts.

## Current-To-Target Movement

Future refactors should move by capability, not by arbitrary file count.

| Current area               | Target direction                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `channels/`                | Provider-specific channel adapters under `adapters/channels/`; channel-neutral ports and types under `domain` or `application`. |
| `control/server/`          | Control HTTP adapter under `adapters/control-http/`; route behavior becomes application use cases.                              |
| `cli/`                     | CLI adapter under `adapters/cli/`; setup and admin operations become application use cases.                                     |
| `adapters/storage/postgres/` | Postgres storage adapter implementation.                                                                                      |
| provider-specific runner folders | LLM adapter-owned runner code under `adapters/llm/<provider>/` or equivalent.                                                    |
| `runtime/group-*`          | Runtime queues and processors keyed by canonical app, agent, conversation, thread, session, and run context.                    |
| `platform/group-folder*`   | Workspace projection and snapshot behavior under runtime/application boundaries.                                                |
| `memory/`                  | Application memory services plus storage and LLM extractor adapters.                                                            |
| `jobs/`                    | Application job lifecycle plus runtime scheduler adapter.                                                                       |

## Explicit Non-Goals For This Docs Phase

- Do not refactor implementation files.
- Do not move source folders.
- Do not add compatibility layers for unsupported local state.

The next implementation phase should use these docs as the decision source
before moving code.
