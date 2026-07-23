# Architecture Docs

This directory is the canonical technical input for planning and decomposition.

Use it for documents that explain how the system should work, for example:
- system context and boundaries
- domain model and invariants
- runtime flows and lifecycle
- integration contracts
- deployment and operational constraints
- support, observability, and recovery requirements

Recommended shape:
- `00-handoff-guide.md` — reading order and implementation priorities
- `10-19-*.md` — core architecture and runtime docs
- `90-99-*.md` — appendices, migration notes, or reference material

Rules:
- keep these docs implementation-relevant
- prefer one concern per file
- link related docs instead of duplicating content
- if a document changes product intent, mirror the decision in `docs/decisions/`
- if docs conflict, the newer explicit decision in `docs/decisions/` wins

- [Canonical domain model](./canonical-domain-model.md)
- [Personal and enterprise modes](./personal-and-enterprise-modes.md)
- [Agent runtime and SDK control plane](./agent-runtime.md)
- [Multi-agent provider configuration](./multi-agent-provider-configuration.md)
- [Conversation interactions](./channel-interactions.md)
- [Autonomous jobs](./autonomous-jobs.md)
- [Live horizontal execution](./live-horizontal-execution.md)
- [Multi-worker job execution](./multi-worker-execution.md)

## State, Access, And Safety

- [Durable state boundary](./durable-state-boundary.md)
- [Compact human settings.yaml](./compact-human-settings-yaml.md)
- [Credential management](./credential-management.md)
- [Capability management](./capability-management.md)
- [Browser capability](./browser-capability.md)
- [Session resume](./session-resume.md)
- [Local files policy](./local-files-policy.md)
- [Local state inventory](./local-state-inventory.md)
- [Postgres query policy](./postgres-query-policy.md)

## Operations

- [Deployment profiles](./deployment-profiles.md)
- [Current verification commands](./current-verification-commands.md)
- [Operator trust and runtime honesty](./operator-trust-runtime-honesty.md)
- [Web UI delivery phases](./web-ui/README.md)
