---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-22
---

# Early Stage No Backcompat

## Context

Gantry is early-stage with no live users. The pre-adopt working contract
(`docs/context/migrated-AGENTS.md`, Coding Rules) established this as a
standing choice rather than a per-PR judgement call.

## Decision

Prefer deleting legacy code over compatibility shims. Do not add migration
compatibility commands, auto-migration flows, cleanup shims, or runtime
branches that exist only to support old local state.

"No users are live" means no EXTERNAL users. The owner's live deployment
(launchd `com.gantry`) is real and its durable state — Postgres data,
settings, credentials, memory — is preserved by migrating it MANUALLY to the
new state when a breaking change lands; a breaking PR names the manual
migration step it requires. (Clarified at sign-off grill, 2026-07-22.)

## Consequences

- Breaking replacements remove the obsolete code paths, schemas, tests, docs,
  exports, and wiring in the same change (or retain them with owner, reason,
  and removal condition).
- Reviews should not flag breaking changes as regressions on compatibility
  grounds while this decision stands.
- Revisit when real deployments exist; supersede with a compatibility policy
  at that point.
