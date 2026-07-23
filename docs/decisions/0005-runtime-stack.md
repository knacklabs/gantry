---
status: accepted
confirmed_by: "vrknetha"
date: 2026-04-25
---

# Runtime Stack Decision

## Context

Gantry is becoming a personal and enterprise agent runtime platform. The core runtime must stay easy to embed, ship, and reason about without making enterprise application frameworks part of its internal architecture.

Enterprise NestJS and NextJS apps may use Gantry, but they should integrate through the SDK and control API. They should not import runtime internals.

## Decision

- Core runtime remains plain TypeScript and Node.js.
- Domain, application, and runtime layers must not depend on an HTTP framework.
- Control HTTP is an adapter.
- CLI is an adapter.
- NestJS and NextJS are not used inside the core runtime.
- Existing enterprise NestJS and NextJS apps integrate through the SDK or control API.
- An Admin Web UI, if built later, should be a separate app.
- Keep Drizzle and Postgres for persistence.
- Keep pg-boss for jobs.
- Keep Zod and the contracts package for shared contracts.
- Keep the Anthropic SDKs as LLM provider adapters, not as the core architecture.

The lightweight framework decision for the control HTTP adapter is Fastify. The current control server is hand-written Node HTTP and should not be force-migrated before architecture Phase 00. Fastify is introduced as an isolated adapter dependency and must remain under `apps/core/src/adapters/control-http/` until a deliberate adapter migration is planned.

## Alternatives Considered

- NestJS in the runtime: rejected because it would make the core runtime depend on an enterprise application framework and encourage importing internals instead of using the SDK/control API boundary.
- NextJS in the runtime: rejected because UI and server-rendering concerns belong in separate apps, not in the core runtime process.
- Express or tRPC for control HTTP: rejected for now. Fastify gives a small, explicit HTTP adapter path without changing the runtime domain model.
- Plain Node HTTP forever: deferred. The current server can remain until a controlled adapter migration, but new control HTTP framework code should use Fastify in the adapter boundary.

## Consequences

- Runtime code remains framework-light and testable without HTTP framework coupling.
- Enterprise app teams integrate through published contracts instead of runtime source imports.
- Control HTTP can gain a structured framework later without forcing CLI, domain, application, or runtime layers to know about it.
- Framework dependency checks should reject NestJS and NextJS in core runtime layers, Fastify outside the control HTTP adapter, and Anthropic SDK imports outside approved provider adapter paths.

## Rollback Or Migration Notes

If Fastify proves unsuitable, replace the control HTTP adapter decision before migrating routes. Do not add a second HTTP framework in parallel. Keep any route migration single-cut and contained to the adapter.
