# AGENTS-WEB-1-1: Custom role and agent snapshot foundation

## Objective

Persist reusable, app-scoped custom role templates and immutable role snapshots
inside agent configuration versions. This makes a role safe to reuse while
ensuring template mutation or deletion can never change an existing agent.

## Exact changes

- Add a small `CustomRole` domain type, repository port, Postgres schema,
  migration, and repository implementation with app-scoped unique names.
- Extend `AgentConfigVersion` and its schema/repository mapping with a role
  snapshot containing display name, prompt, and optional source role id.
- Add a `CustomRoleService` for validation and snapshot construction; it has no
  browser, source, capability, or conversation authority.
- Extend `PromptProfileService` to accept a stored role snapshot as the persona
  layer while retaining all protected Gantry runtime and safety sections.
- Add focused tests for snapshot immutability and protected prompt layers.

## Boundaries

- A custom role is template data, not a capability or source grant.
- Existing config versions are not rewritten when roles change or are deleted.
- No browser routes, role editor, agent wizard, profile-file editing, settings
  mirror, or source/capability mutation is added in this task.
- The migration is a clean early-stage shape change with no compatibility shim
  or automatic old-state import.

## Proof

- `CustomRoleService > preserves an agent role snapshot when its source template changes or is deleted`
  proves future-template mutation does not affect the saved snapshot.
- `prompt-profile-service > compiles a custom role snapshot without replacing protected runtime guidance`
  proves role text cannot displace generated runtime/safety guidance.
- Contract build, typecheck, and migration validation prove wiring and schema
  reconciliation.

## Review focus

Check app isolation, unique-name enforcement, immutable snapshot semantics,
migration/schema/journal completeness, and the absence of any source-to-
authority or browser-auth shortcut.
