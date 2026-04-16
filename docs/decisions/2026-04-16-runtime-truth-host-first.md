# ADR 2026-04-16: Runtime Truth Is Host-First

## Context

MyClaw currently has one working runtime implementation in production code: host execution.

Several active docs and scripts still described a container-first dual-mode model (`AGENT_RUNTIME=container|host`) and referenced missing files such as:
- `apps/core/src/runtime/container-runner.ts`
- `apps/core/src/runtime/container-runtime.ts`

This created a half-real supported mode: users were told container runtime was first-class even though host runtime is the only complete and maintained execution path in this repository.

## Decision

MyClaw will document and support **host runtime only** for now.

Decision details:
- Host runtime is the only official runtime mode in active docs and CLI surfaces.
- Public npm scripts only expose `npm run dev` and `npm start` for runtime execution.
- Setup/doctor/runtime diagnostics must report host runtime truth consistently.
- Docker Compose/container runtime work is deferred to a future implementation task.
- No `ExecutionRuntimeProvider` abstraction is introduced now because there is not a second real runtime implementation to justify that seam.

## Alternatives Considered

1. Keep dual-mode `AGENT_RUNTIME=container|host` in docs and scripts.
- Rejected because it preserves a misleading contract and keeps a non-working public path visible.

2. Add a provider abstraction now (`ExecutionRuntimeProvider`) before container runtime exists.
- Rejected because it adds complexity without a second implementation.

3. Implement Docker Compose runtime in this change.
- Deferred because this ADR is a runtime-truth correction and cutover, not a packaging/runtime implementation project.

## Consequences

- Users receive accurate setup and operations guidance aligned with actual runtime behavior.
- Security documentation now reflects host trust boundaries instead of claiming active container isolation.
- Legacy names remain in some internals (`container_config`, `containerName`, `containerInput`, `AdditionalMount.containerPath`) and are explicitly treated as naming debt, not runtime support.
- Future container/Docker Compose work must land as a concrete implementation task, then re-open runtime mode documentation.

## Rollback Or Migration Notes

- Rollback path: if a real container runtime implementation ships later, create a follow-up ADR to define supported dual-mode behavior and required validation/doctor surfaces.
- Migration for existing users: remove use of `AGENT_RUNTIME`, `npm run dev:container`, and `npm run start:container`; use `npm run dev` / `npm start`.
- Follow-up cleanup backlog (separate tasks):
  - rename `container_config` to `agent_config` with schema migration
  - rename `containerName` to runtime-process naming
  - rename `containerInput` in `packages/agent-runner`
  - revisit `AdditionalMount.containerPath`
