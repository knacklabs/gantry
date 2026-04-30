# Codebase Refactor Principles

MyClaw is moving from a personal Anthropic/Claude SDK assistant toward a personal and enterprise agent runtime platform. This refactor must be a clean cut, not a gradual compatibility layer.

## Product Direction

- Treat personal Telegram/WhatsApp and enterprise Slack/Teams/WebUI as deployment modes.
- Keep the core runtime provider-neutral and channel-neutral.
- Model user-visible behavior through canonical app, agent, conversation, thread, message, and session concepts before adapting it to any channel.
- Keep ACP/ACPX as orchestration integrations, not assumptions inside runtime contracts.

## Dependency Direction

- `domain` owns provider-free entities, value objects, policy decisions, and ports.
- `domain` must not import adapters, runtime orchestration, CLI, HTTP, Postgres, Slack, Telegram, Teams, WhatsApp, Claude, Anthropic SDK, OpenAI, Gemini, or provider-specific packages.
- `application` coordinates use cases and may depend on domain and ports, but not concrete provider implementations.
- `adapters` implement ports and may depend on external systems such as HTTP frameworks, databases, channel SDKs, LLM SDKs, credential brokers, and sandbox providers.
- CLI and control HTTP are adapters. They should translate commands or requests into application/runtime calls instead of becoming privileged core logic.
- Runtime wiring composes adapters and application services. It should not accumulate provider-specific branching.

## Provider And Channel Boundaries

- Channel adapters must normalize inbound provider payloads into canonical message/session concepts.
- Outbound delivery should be expressed through channel-neutral response, progress, prompt, and permission surfaces before channel rendering.
- LLM-specific prompts, model IDs, SDK calls, tool callback shapes, and credential handling belong behind provider ports.
- Risky tool execution must pass through deterministic permission evaluation and sandbox policy before any provider-specific callback grants access.
- Provider-specific failures should be translated at adapter boundaries into stable application errors or decisions.

## Shared Code And Utilities

- Do not create broad `common`, `misc`, or `utils` modules.
- Avoid wrapper-only files that only re-export a split module or hide ownership.
- Shared helpers must have a clear layer owner and a tight responsibility.
- Infrastructure utilities such as logging, redaction, time, and error boundaries are acceptable only when they remain outside domain, have focused APIs, and are covered by tests.
- Do not expand the existing logger/global error handler into a generic utility layer as part of this prep work. Audit it later when extracting provider/runtime boundaries.

## Clean-Cut Refactor Policy

- Prefer deleting obsolete provider/channel code over adding shims because there are no live users yet.
- Do not add fallback runtime branches, migration commands, or compatibility cleanup flows for unsupported local state unless explicitly approved.
- If a breaking change requires manual local cleanup, document the one-time step in the relevant architecture or decision doc and keep shipped runtime behavior single-path.
- Update `docs/architecture/` or `docs/decisions/` for every major boundary change.
