# Architecture Docs

These docs describe Gantry's current runtime architecture and public technical
boundaries. Decision records in [../decisions](../decisions/README.md) take
precedence when they conflict with broader architecture notes.

## Start Here

- [Architecture overview](./overview.md) - top-down runtime map.
- [Runtime components](./runtime-components.md) - source-reading guide for runtime parts.
- [Components overview](./components.md) - system component map.
- [Framework boundaries](./framework-boundaries.md) - ownership rules between layers.

## Runtime Model

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
