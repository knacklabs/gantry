# Source organization

Gantry is a TypeScript monorepo with a runtime application, shared contracts and
SDKs, examples, deployment assets, and repository-owned engineering machinery.

- `apps/core/src/domain/` owns product concepts and ports. It must not import
  provider SDKs, Postgres implementations, channel adapters, CLI code, or
  composition-root wiring.
- `apps/core/src/application/` coordinates use cases through domain ports.
- `apps/core/src/adapters/` implements provider, persistence, model, storage,
  and other external boundaries.
- `apps/core/src/app/` and runtime composition modules assemble processes.
- `apps/core/src/channels/` owns provider-specific message translation and
  delivery.
- `apps/core/src/cli/` owns operator command parsing and presentation.
- `packages/contracts/` owns shared public TypeScript contracts;
  `packages/sdk/` owns the client generated or implemented against them.
- `examples/` demonstrates public behavior and cannot become runtime authority.
- `ops/` owns deployment assets; `scripts/` owns deterministic repository
  checks and maintenance commands.
- `docs/` explains current product and engineering behavior; `plans/`
  describes intended work; `factory/` assists maintainers.

**Mechanical:** `npm run check:architecture` enforces mapped import layers,
frozen historical architecture inputs, line budgets, and repository structure.

**Review:** New cross-layer imports must point inward through Gantry-owned
interfaces. Composition roots may know implementations; domain and application
owners may not.

**Recommendation:** Put a new concern at the narrowest stable owner. Prefer a
small domain port plus an adapter over leaking an SDK type across layers.
