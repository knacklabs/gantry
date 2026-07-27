# Architecture Docs

This directory is the canonical technical input for planning and decomposition.

Start with the source-audited [Codebase Guide](../CODEBASE_GUIDE.md), then use
[overview.md](./overview.md) for the contributor map,
[runtime-components.md](./runtime-components.md) for execution details, and
[components.md](./components.md) for the business-owner explanation.

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

Planning and decomposition should read this directory before coding starts.
