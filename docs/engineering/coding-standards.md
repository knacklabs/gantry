# Coding standards

Use TypeScript names that expose product intent: PascalCase types/classes,
camelCase values/functions, and kebab-case files. Export the smallest stable
surface; keep implementation helpers private to their module.

Functions should perform one coherent operation, make ownership and cleanup
visible, and accept validated values rather than repeatedly parsing raw input.
Classes should own a durable responsibility, not serve as namespaces. Comments
explain invariants, trade-offs, or non-obvious constraints—not syntax.

Expected dependency direction is domain → none, application → domain ports,
adapters → application/domain contracts, and composition/runtime → all required
implementations. Provider payloads and SDK types stop at adapters.

Typed expected errors belong at product boundaries. Unexpected failures retain
their cause and reach the owning observability boundary. Async work must be
awaited, intentionally detached with supervision, or durably queued; cancellation,
timeouts, leases, and resource disposal must have explicit owners.

Delete dead compatibility paths when no supported consumer requires them.
Generated files identify their source and regeneration command and are not
manually edited.

**Mechanical:** TypeScript, ESLint, Prettier, architecture checks, and tests run
through the scripts in `package.json`.

**Review:** Reviewers evaluate responsibility size, dependency direction, trust
boundary validation, async lifecycle, compatibility claims, and whether a public
export is actually needed.

**Recommendation:** Prefer plain functions and existing repository patterns over
new abstractions. A deviation should make the governing constraint clearer.
