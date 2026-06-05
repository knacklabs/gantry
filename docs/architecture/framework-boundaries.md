# Framework Boundaries

Gantry keeps the core runtime plain TypeScript and Node.js. Framework dependencies are adapters, not domain architecture.

## Allowed Dependencies By Layer

| Layer or adapter | Allowed framework dependencies |
| --- | --- |
| Domain | None. Domain code must not import HTTP, channel, browser, sandbox, CLI, or LLM SDK frameworks. |
| Application | None. Application orchestration must use ports and contracts, not framework APIs. |
| Runtime | None. Runtime queues, agent spawning, memory injection, and session flow must not import HTTP frameworks or enterprise app frameworks. |
| CLI adapter | CLI libraries only. CLI code adapts user input into runtime/application calls. |
| Control HTTP adapter | Fastify, `@fastify/cors`, and `@fastify/helmet` only. |
| Slack channel adapter | Slack Bolt only. |
| Telegram channel adapter | Grammy and Grammy plugins only. |
| Anthropic LLM adapter | Anthropic SDKs only. |
| Browser adapter | Playwright only, behind the browser adapter boundary. |
| Sandbox adapter | Sandbox libraries only. Docker/cloud backends are future optional adapters. |
| Admin Web UI later | Separate app. It may use a web framework but must integrate through the SDK/control API. |

## Current Boundaries

- Fastify is allowed only in `apps/core/src/adapters/control-http/`.
- Slack Bolt is allowed only in `apps/core/src/channels/slack/`.
- Grammy is allowed only in `apps/core/src/channels/telegram/`.
- Anthropic SDKs are allowed only in approved Anthropic provider adapter paths. The current provider-boundary target is `apps/core/src/adapters/llm/anthropic-claude-agent/`; remaining runner, memory, config, storage, shared catalog, and test references are exact count-based exceptions tracked by `.codex/provider-boundary-exceptions.json`.
- Playwright belongs only behind the browser adapter boundary and must not enter domain, application, or core runtime layers.
- Sandbox libraries belong only behind the sandbox adapter boundary and must not enter core runtime layers. Docker/cloud sandbox backends are future optional adapters, not required v1 dependencies.

NestJS, NextJS, Express, tRPC, Socket.io, Prisma, BullMQ, Temporal, LangChain, and LlamaIndex are not core runtime dependencies.
