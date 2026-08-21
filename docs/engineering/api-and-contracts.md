# API and contract evolution

Public contracts include the Control API, Node SDK, CLI, settings, environment
variables, database schema, webhooks, runtime events, public TypeScript types,
and provider-facing Gantry interfaces.

A breaking change removes or changes behavior a supported consumer can rely on:
names, types, validation, defaults, ordering, authentication, persistence,
delivery, or error semantics. Early-stage no-backcompat policy permits clean
cutovers only when the change names affected consumers and updates all owned
surfaces together; it does not permit accidental drift.

Update the authoritative contract first, then implementation, validation,
generated artifacts, examples, and docs in the same change. Deprecation requires
a named consumer, replacement, warning path, removal condition, and timeline.
Schema changes follow the migration policy. Generated SDK/OpenAPI output must
remain synchronized with its source.

**Mechanical:** typecheck, build, contract tests, OpenAPI/SDK generation checks,
migration checks, and package-content validation cover owned surfaces.

**Review:** Reviewers inspect compatibility, migration/rollback, error shape,
authorization, examples, and every projection of the changed contract.

**Recommendation:** Prefer additive evolution when it preserves a real supported
consumer; otherwise make one explicit, tested cutover rather than hidden shims.
