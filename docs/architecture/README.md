# Architecture Docs

This directory is Gantry's canonical technical input for planning and
decomposition. Current source and accepted decisions outrank explanatory docs;
historical goal prompts, plans, audits, and handoffs preserve context but do not
become current runtime truth by proximity.

Repository changes must also follow the canonical
[architecture rules](../engineering/architecture-rules.md), which define
dependency direction, boundary ownership, and the required proof for structural
changes.

## Current architecture path

Read these in order for a source-derived view of the running system:

1. [Codebase Guide](../CODEBASE_GUIDE.md) — source-audited repository and
   package map.
2. [Architecture Overview](./overview.md) — boundaries, roles, and ownership.
3. [System Atlas](./system-atlas.md) — complete feature-family status map.
4. [Runtime Flows](./runtime-flows.md) — live turns, permissions, delivery,
   jobs, memory, dreaming, company brain, and recovery.
5. [Scaling and Deployment](./scaling-and-deployment.md) — one binary across
   workstation and role-separated fleet topology, including current ceilings.
6. [Interactive Atlas](./atlas/README.md) — five revision-pinned, self-contained
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

## Historical architecture records

This directory also preserves goal prompts, assumptions, draft plans, audits,
reviews, validations, measurements, and handoffs. Files that are not part of
the current architecture path above do not become current runtime truth merely
because they remain under `docs/architecture/`; they are context-only history
unless a current indexed document independently verifies and adopts a claim.

The machine-readable [documentation inventory](../documentation-inventory.json)
classifies every governed architecture, implementation, feature, decision, and
plan path by lifecycle, authority, and intended action. Historical files stay
in place to preserve inbound links and decision context. Generated atlas
artifacts remain derived evidence and must be regenerated from their pinned
source workflow rather than hand-edited.

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
