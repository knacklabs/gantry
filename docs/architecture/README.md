# Architecture Docs

This directory is Gantry's canonical technical input for planning and
decomposition. Current source and accepted decisions outrank explanatory docs;
historical goal prompts, plans, audits, and handoffs preserve context but do not
become current runtime truth by proximity.

## Current architecture path

Read these in order for a source-derived view of the running system:

1. [Architecture Overview](./overview.md) — boundaries, roles, and ownership.
2. [System Atlas](./system-atlas.md) — complete feature-family status map.
3. [Runtime Flows](./runtime-flows.md) — live turns, permissions, delivery,
   jobs, memory, dreaming, company brain, and recovery.
4. [Scaling and Deployment](./scaling-and-deployment.md) — one binary across
   workstation and role-separated fleet topology, including current ceilings.
5. [Interactive Atlas](./atlas/README.md) — five revision-pinned, self-contained
   diagrams and their [source evidence](./atlas/source-evidence.md).

Use the subsystem docs for authoritative detail rather than copying their
contracts into a new overview:

- [Runtime Components](./runtime-components.md)
- [Canonical Domain Model](./canonical-domain-model.md)
- [Live Horizontal Execution](./live-horizontal-execution.md)
- [Multi-Worker Job Execution](./multi-worker-execution.md)
- [Deployment Profiles](./deployment-profiles.md)
- [Multi-Agent Provider Configuration](./multi-agent-provider-configuration.md)
- [Capability Management](./capability-management.md)
- [Autonomous Jobs](./autonomous-jobs.md)
- [Browser Capability](./browser-capability.md)
- [Company Brain Core](./company-brain-core.md)
- [Session Resume](./session-resume.md)
- [Memory and Dreaming](../MEMORY.md)

## Document contract

Use architecture docs for system context, domain invariants, runtime flows,
integration contracts, deployment constraints, recovery, and observability.

- Keep one concern per file and link related authoritative detail.
- Label shipped, optional, default-off, deferred, and non-goal behavior
  precisely.
- Keep provider-specific and channel-specific behavior behind adapters.
- Do not imply that ingress, messages, prompts, memory, or model output grant
  tool authority.
- If a document changes product intent or an authority boundary, record the
  accepted decision; the newer accepted decision wins any conflict.
- Preserve historical records. Correct current entrypoints and add explicit
  supersession/context links instead of rewriting the past as if it never
  happened.
