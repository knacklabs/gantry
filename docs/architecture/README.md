# Architecture Docs Contract

Store architecture-level design inputs for planning and decomposition here.

For Gantry, canonical architecture references are:

- `docs/architecture/overview.md` — top-down architecture map with diagrams (start here)
- `docs/architecture/canonical-domain-model.md`
- `docs/architecture/target-folder-structure.md`
- `docs/architecture/personal-and-enterprise-modes.md`
- `docs/architecture/runtime-components.md`
- `docs/architecture/agent-runtime.md`
- `docs/architecture/credential-management.md`
- `docs/architecture/anthropic-claude-adapter-materialization.md`
- `docs/architecture/durable-state-boundary.md`
- `docs/architecture/local-files-policy.md`
- `docs/architecture/local-state-inventory.md`
- `docs/architecture/session-resume.md`
- `docs/architecture/compact-human-settings-yaml.md`
- `docs/architecture/operator-trust-runtime-honesty.md`
- `docs/MEMORY.md`
- `docs/REQUIREMENTS.md`
- `docs/SPEC.md`

When these references conflict, decision records under `docs/decisions/` take
precedence. The canonical product architecture starts with
`docs/decisions/0001-agent-runtime-platform.md`.

When adding architecture docs for a feature run:

- capture boundaries such as orchestrator, runtime, channels, and storage
- capture data flow and failure handling
- link to concrete files and interfaces
