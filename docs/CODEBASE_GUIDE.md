# Gantry Codebase Guide

This guide describes Gantry from the implementation on `main`, not from older
planning documents. It was refreshed against commit
`db41baa550a5779f119bf2cfa1b9890856afc69d` on 2026-07-27.

## What Gantry Is

Gantry is a self-hosted runtime that accepts work from chat providers,
applications, schedules, and signed ingress endpoints; resolves an agent and
its current policy; runs a model through one of two execution adapters; and
persists messages, sessions, runs, memory, approvals, events, and audit state in
Postgres.

It is not a hosted multi-tenant SaaS control plane, a generic workflow engine,
or a thin chatbot wrapper.

## Repository Coverage

The audit read every tracked file byte-for-byte and parsed every JavaScript and
TypeScript source file with the TypeScript parser.

| Measure                    |                                                             Result |
| -------------------------- | -----------------------------------------------------------------: |
| Tracked files              |                                                              2,784 |
| Text files                 |                                                              2,783 |
| Binary files               |                                                                  1 |
| Text lines                 |                                                            792,712 |
| Parsed TS/TSX/JS/MJS files |                                                              2,097 |
| Imports                    |                                                             10,893 |
| Exported declarations      |                                                              6,487 |
| Named declarations         |                                                             10,908 |
| Parser syntax errors       |                                                                  0 |
| Audit tree SHA-256         | `1a554f3aa98b240fbc23e7927e0aa251a6c5eb954a69e763fc15eaf3bca5cdbd` |

Generated migration snapshots, generated OpenAPI types, tests, factory
artifacts, and historical decision records are included in those totals. The
architecture below is based on runtime source, schemas, route registrations,
provider registries, and executable tests.

## Top-Level Architecture

```text
Slack / Telegram / Discord / App / Teams setup
SDK / Control API / Direct LLM API / Signed ingress / Scheduler
                              |
                              v
                Channel and control adapters
                              |
                              v
          Canonical conversation + session + job intent
                              |
                              v
       Durable admission, queueing, leases, and run ownership
                              |
                              v
        Prompt + memory + capability policy composition
                              |
               +--------------+--------------+
               |                             |
               v                             v
     Anthropic Claude Agent SDK       DeepAgents + LangChain
               |                             |
               +--------------+--------------+
                              |
                              v
        Permission engine -> sandbox -> credential broker
                              |
                              v
    Gantry tools / Browser / Skills / approved MCP / local CLI
                              |
                              v
       Runtime events, outbound delivery, audit, Postgres
```

The process entry point is
[`apps/core/src/index.ts`](../apps/core/src/index.ts). It delegates boot to
[`apps/core/src/app/index.ts`](../apps/core/src/app/index.ts), which resolves the
process role, loads authoritative settings, initializes storage, connects
channels, starts runtime and scheduler services, and finally mounts the control
server.

## Boot Sequence

1. Resolve `GANTRY_PROCESS_ROLE`. Unknown values fail startup.
2. Construct the runtime app, execution-adapter registry, sandbox provider,
   queue, and channel wiring.
3. Run startup and storage preflight.
4. In fleet mode, load the latest typed settings revision from Postgres. A
   fleet worker without an authoritative revision stays unready and does not
   claim jobs.
5. Connect enabled providers. Split-role processes can connect outbound-only.
6. Start durable live-turn admission, IPC watchers, scheduler services,
   recovery loops, outbound delivery recovery, and fleet-only reconcilers.
7. Start the Control API with either the full or operations-only route profile.
8. Register ordered shutdown handlers that drain admission and release runtime
   resources.

The main composition files are:

- [`apps/core/src/app/index.ts`](../apps/core/src/app/index.ts)
- [`apps/core/src/app/bootstrap/runtime-app.ts`](../apps/core/src/app/bootstrap/runtime-app.ts)
- [`apps/core/src/app/bootstrap/runtime-services.ts`](../apps/core/src/app/bootstrap/runtime-services.ts)
- [`apps/core/src/app/bootstrap/channel-wiring.ts`](../apps/core/src/app/bootstrap/channel-wiring.ts)
- [`apps/core/src/control/server/index.ts`](../apps/core/src/control/server/index.ts)

## Inbound Work Paths

### Interactive provider message

1. A provider adapter normalizes a message into a canonical conversation
   identity.
2. Channel wiring persists the message and dispatches a session interaction
   intent.
3. Durable live admission claims the conversation/thread scope. Process-local
   queues control concurrency; Postgres leases and fencing tokens control
   ownership across workers.
4. The group processor loads pending messages, route settings, session
   continuity, memory context, capabilities, and current policy.
5. The selected execution adapter starts or resumes the model run.
6. Text deltas stream back through the owning channel adapter. Tool calls cross
   the permission and IPC boundaries before execution.
7. Final output, usage, run state, events, and delivery evidence are persisted.

Core implementation:

- [`apps/core/src/runtime/live-turn-authority.ts`](../apps/core/src/runtime/live-turn-authority.ts)
- [`apps/core/src/runtime/live-admission-work-loop.ts`](../apps/core/src/runtime/live-admission-work-loop.ts)
- [`apps/core/src/runtime/group-processing.ts`](../apps/core/src/runtime/group-processing.ts)
- [`apps/core/src/runtime/group-agent-runner.ts`](../apps/core/src/runtime/group-agent-runner.ts)
- [`apps/core/src/runtime/group-queue.ts`](../apps/core/src/runtime/group-queue.ts)

### SDK or Control API session

The SDK calls the Control API over HTTP or a Unix socket. `sendMessage` means
durable acceptance into the runtime event stream; it does not mean that model
work or outbound delivery has completed. Consumers list, stream, or wait for
numbered runtime events.

Primary implementation:

- [`packages/sdk/src/index.ts`](../packages/sdk/src/index.ts)
- [`apps/core/src/control/server/routes/sessions.ts`](../apps/core/src/control/server/routes/sessions.ts)
- [`apps/core/src/application/sessions`](../apps/core/src/application/sessions)
- [`apps/core/src/application/runtime-events`](../apps/core/src/application/runtime-events)

### Scheduled job

Jobs store the prompt, schedule, target, notification routes, setup state,
leases, and run history in Postgres. They inherit the target agent's current
model, harness, capabilities, skills, and MCP bindings at execution time.
pg-boss supplies scheduler triggers; Gantry's job run and lease records are the
durable execution evidence.

Primary implementation:

- [`apps/core/src/jobs/scheduler.ts`](../apps/core/src/jobs/scheduler.ts)
- [`apps/core/src/jobs/execution.ts`](../apps/core/src/jobs/execution.ts)
- [`apps/core/src/application/jobs`](../apps/core/src/application/jobs)
- [`apps/core/src/adapters/storage/postgres/schema/jobs.ts`](../apps/core/src/adapters/storage/postgres/schema/jobs.ts)

### Signed external ingress

`/v1/ingresses` creates narrow, rotatable inbound authority. Invocation checks
the signature, nonce, target policy, app ownership, and allowed action before
dispatching a session message or job trigger. This is distinct from
`/v1/webhooks`, which manages outbound callbacks.

Primary implementation:

- [`apps/core/src/control/server/routes/external-ingress.ts`](../apps/core/src/control/server/routes/external-ingress.ts)
- [`apps/core/src/application/external-ingress`](../apps/core/src/application/external-ingress)
- [`apps/core/src/adapters/storage/postgres/schema/external-ingress.ts`](../apps/core/src/adapters/storage/postgres/schema/external-ingress.ts)

## Execution Surfaces

### Worker agents

Worker agents run in a child process. They can receive the full reviewed
projection: Gantry tools, skills, browser tools, approved commands, and MCP
servers. OS isolation is real only when `runtime.sandbox.provider` is an
enforcing provider such as `sandbox_runtime`; `direct` is a compatibility
provider.

### Inline agents

Inline agents run a lightweight provider loop in the host process. They support
core tools, remote MCP tools, jobs, structured output, and delegation without
mounting raw host filesystem or shell authority.

### Direct LLM API

`POST /llm/v1/messages`, `/llm/v1/messages/count_tokens`, and
`/llm/v1/chat/completions` provide provider-shaped model calls through
Gantry-held credentials. A Control API key with `llm:invoke` is required.

## Model Routing

Users select friendly model aliases. Gantry resolves:

```text
alias -> catalog entry -> provider route -> response family
      -> compatible agent harness -> execution adapter
      -> Model Gateway credential profile
```

The two registered execution adapters are:

- `anthropic:claude-agent-sdk` for the Anthropic SDK lane.
- `deepagents:langchain` for OpenAI, OpenRouter, Bedrock, Vertex, and other
  OpenAI-compatible routes.

`agentHarness` can be `auto`, `anthropic_sdk`, or `deepagents`. `auto` derives
the compatible harness from the model route. An explicit incompatible pairing
fails before runner spawn.

The catalog currently contains 68 entries across 13 providers: Anthropic,
OpenRouter, OpenAI, Groq, DeepSeek, xAI, Together, Fireworks, Cerebras,
Perplexity, Gemini, Bedrock, and Vertex.

Source of truth:

- [`apps/core/src/shared/model-catalog.ts`](../apps/core/src/shared/model-catalog.ts)
- [`apps/core/src/shared/model-catalog-openai-compatible.ts`](../apps/core/src/shared/model-catalog-openai-compatible.ts)
- [`apps/core/src/shared/model-catalog-bedrock.ts`](../apps/core/src/shared/model-catalog-bedrock.ts)
- [`apps/core/src/shared/model-provider-registry.ts`](../apps/core/src/shared/model-provider-registry.ts)
- [`apps/core/src/adapters/llm/default-runtime-adapters.ts`](../apps/core/src/adapters/llm/default-runtime-adapters.ts)

## Channel Support

| Provider        | Runtime state                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------- |
| App / SDK       | Active internal provider                                                                          |
| Slack           | Active, Socket Mode                                                                               |
| Telegram        | Active, Bot API                                                                                   |
| Discord         | Active                                                                                            |
| Microsoft Teams | Setup and discovery scaffold only; runtime transport is deliberately marked `runtime-placeholder` |

The canonical provider registry is
[`apps/core/src/channels/register-builtins.ts`](../apps/core/src/channels/register-builtins.ts).
Provider-specific JID prefixes are adapter details; durable records use
canonical provider, conversation, and thread identities.

## Capabilities, Permissions, and Tools

An agent source and an agent capability are different:

- A source installs or attaches a skill, MCP server, built-in tool, adapter, or
  local CLI.
- A capability is durable execution authority with an immutable version.

At run time, Gantry intersects selected capabilities with current policy.
Unapproved risky calls become signed IPC requests. The host creates durable
pending-interaction state before rendering an approval prompt. A control
approver can choose a one-time grant, a granular durable grant, or denial.

Important boundaries:

- Model output and provider tool input are untrusted.
- A message, SDK request, or ingress invocation never grants tool authority.
- Raw provider tool names are adapter-private.
- `Browser` is one canonical capability projected into Gantry browser tools.
- MCP server discovery is inventory, not authority.
- Locked agents fail closed on authority-changing IPC requests.

Primary implementation:

- [`apps/core/src/application/permissions`](../apps/core/src/application/permissions)
- [`apps/core/src/runtime/permission-classifier.ts`](../apps/core/src/runtime/permission-classifier.ts)
- [`apps/core/src/runtime/ipc-interaction-processing.ts`](../apps/core/src/runtime/ipc-interaction-processing.ts)
- [`apps/core/src/shared/tool-rule-matcher.ts`](../apps/core/src/shared/tool-rule-matcher.ts)
- [`apps/core/src/runner/tool-gate-core.ts`](../apps/core/src/runner/tool-gate-core.ts)

## Credential Boundary

Model credentials are Model Access credentials resolved through the Gantry
Model Gateway. The host gives a runner a loopback gateway URL and short-lived
run token; it does not give the runner the upstream provider secret.

Tool/API credentials use a separate capability lane. Approved tool subprocesses
receive provider-neutral egress proxy and trust configuration, never model
provider tokens or broker proxies.

Credential modes include encrypted API keys, Claude Code OAuth, AWS
role/profile and Secrets Manager references, Vertex ADC and Secret Manager
references, and other provider-specific registry modes.

Primary implementation:

- [`apps/core/src/adapters/credentials`](../apps/core/src/adapters/credentials)
- [`apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts`](../apps/core/src/adapters/llm/anthropic-claude-agent/gantry-model-gateway.ts)
- [`apps/core/src/application/model-credentials`](../apps/core/src/application/model-credentials)
- [`apps/core/src/shared/model-provider-registry.ts`](../apps/core/src/shared/model-provider-registry.ts)

## Browser

Browser is host-managed and policy-gated. Gantry launches visible Chrome with a
nonzero loopback CDP port and a profile derived from trusted runtime context.
The agent cannot select an arbitrary profile directory. Actions use signed
per-tool IPC, stable visible tab indexes, action deadlines, per-site usage
policy, result sanitization, and bounded artifacts.

In fleet mode, profile bytes can be snapshotted to local or S3 artifact storage
and restored across workers with hashes and fencing metadata.

Primary implementation:

- [`apps/core/src/runtime/browser-capability.ts`](../apps/core/src/runtime/browser-capability.ts)
- [`apps/core/src/runtime/ipc-browser-handler.ts`](../apps/core/src/runtime/ipc-browser-handler.ts)
- [`apps/core/src/adapters/browser`](../apps/core/src/adapters/browser)
- [`apps/core/src/runtime/browser-profile-sync.ts`](../apps/core/src/runtime/browser-profile-sync.ts)

## Memory and Brain

### Durable memory

The active memory boundary is app + agent + subject. A direct/private
conversation uses a user subject; a group/channel uses the parent conversation
subject. Provider threads and topics affect routing and session continuity but
do not split durable memory.

Lexical retrieval is always available. When embeddings are enabled and ready,
Gantry fuses lexical and vector candidates with reciprocal-rank fusion.
Turn-time recall never writes embeddings.

Automatic boundary capture writes safe session digests and evidence. Promotion,
updates, and embedding writes happen during dreaming. Destructive or ambiguous
changes become review requests.

### Company brain

The brain subsystem imports pages, extracts entities and edges, stores optional
embeddings, and runs a separate dreaming lifecycle for organization knowledge.
It is not a replacement for subject-scoped runtime memory.

Primary implementation:

- [`apps/core/src/memory`](../apps/core/src/memory)
- [`apps/core/src/brain`](../apps/core/src/brain)
- [`apps/core/src/adapters/storage/postgres/schema/memory.ts`](../apps/core/src/adapters/storage/postgres/schema/memory.ts)
- [`apps/core/src/adapters/storage/postgres/schema/brain.ts`](../apps/core/src/adapters/storage/postgres/schema/brain.ts)

## Storage and Durable State

Postgres is the runtime authority. Major schema groups include:

- apps, users, agents, versions, providers, accounts, conversations,
  participants, approvers, messages, parts, and attachments;
- sessions, provider sessions, digests, runs, jobs, triggers, leases, live
  admission, commands, and runtime events;
- permissions, rules, decisions, audit events, pending interactions, transient
  grants, tools, skills, MCP servers, and capability secrets;
- memory evidence, candidates, items, embeddings, dreaming runs, decisions,
  reviews, brain pages/entities/edges, and observer insights;
- outbound deliveries, final answers, items, receipts, webhooks, ingresses, and
  invocations;
- worker registrations, settings revisions, runtime dependencies, browser
  profiles, file artifacts, and sandbox state.

Migrations live under
[`apps/core/src/adapters/storage/postgres/schema/migrations`](../apps/core/src/adapters/storage/postgres/schema/migrations).
The runtime refuses to initialize against stale migrations.

## Runtime Events and Delivery

Runtime events are append-only durable observations with a Postgres
notification wake-up path and cursor polling fallback. They power SDK
list/wait/SSE flows, scheduler evidence, permission lifecycle, browser
activity, usage, and webhook delivery.

Outbound delivery plans destinations, segments provider-sized messages,
persists attempts and receipts, and recovers retryable or ambiguous delivery.
`/v1/webhooks` manages HMAC-signed outbound callbacks and dead-letter replay.

## Deployment Roles

| Role          | Full API | Live turns | Jobs | Provider inbound | Bake/reconcile |
| ------------- | -------- | ---------- | ---- | ---------------- | -------------- |
| `all`         | Yes      | Yes        | Yes  | Yes              | Yes            |
| `control`     | Yes      | No         | No   | No               | No             |
| `live-worker` | Ops only | Yes        | No   | Yes              | Reconcile      |
| `job-worker`  | Ops only | No         | Yes  | No               | Yes            |

`all` is the workstation default. Split roles support fleet deployment. The
worker roles expose health/diagnostic routes but intentionally do not mount
administrative mutation routes.

## Public API

The executable OpenAPI document currently defines 120 operations covering:

- health, readiness, diagnostics, and usage;
- agents, profiles, capabilities, providers, accounts, conversations, and
  approvers;
- sessions, messages, events, interactions, runs, and direct LLM calls;
- jobs, triggers, webhooks, signed ingresses, and observer digests;
- memory, dreaming, reviews, brain import, skills, MCP servers, credentials,
  models, and settings.

The source of truth is
[`apps/core/src/control/server/openapi.ts`](../apps/core/src/control/server/openapi.ts).
A running full control process serves `/openapi.json` and `/docs`.

## CLI

The `gantry` CLI owns setup, health, service management, and local operator
workflows. Major command groups include:

```text
setup  doctor  status  next  start  stop  restart  logs
local  provider  conversation  agent  browser  jobs  model
brain  credentials  settings  workers  bake  artifacts
service  skill  mcp  memory
```

Runtime home defaults to `~/gantry` and can be changed with `GANTRY_HOME` or
`--runtime-home`.

## Repository Layout

| Path                        | Responsibility                                             |
| --------------------------- | ---------------------------------------------------------- |
| `apps/core/src/app`         | Composition and lifecycle                                  |
| `apps/core/src/domain`      | Domain types and ports                                     |
| `apps/core/src/application` | Use cases and policy orchestration                         |
| `apps/core/src/adapters`    | Postgres, models, browser, sandbox, artifacts, credentials |
| `apps/core/src/runtime`     | Live execution, queues, IPC, sessions, browser             |
| `apps/core/src/jobs`        | Scheduler and autonomous execution                         |
| `apps/core/src/channels`    | Provider adapters and delivery                             |
| `apps/core/src/memory`      | Scoped memory and dreaming                                 |
| `apps/core/src/brain`       | Company knowledge graph                                    |
| `apps/core/src/control`     | HTTP/Unix control plane and OpenAPI                        |
| `apps/core/src/cli`         | Operator CLI and onboarding                                |
| `packages/contracts`        | Shared Zod/TypeScript contracts                            |
| `packages/sdk`              | Node SDK and generated OpenAPI types                       |
| `examples`                  | Control API and Next.js usage examples                     |
| `ops`                       | Docker, launchd, Postgres, and Terraform deployment        |

## Build and Verification

```bash
npm ci
npm run check:architecture
npm run typecheck
npm run lint
npm run test:unit
npm run build
```

Postgres integration and end-to-end suites require an isolated database through
`GANTRY_TEST_DATABASE_URL`. Enable `vector` and `pg_trgm` before migrations.

At the audited commit, architecture checks and type checking pass, and all
7,460 unit tests pass outside a restricted localhost sandbox. Lint and
production dependency audit findings are tracked in [`../bug.md`](../bug.md).
