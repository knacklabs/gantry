# Permission Decision Memory

`permission_decision_memory` stores machine/owner records and person-scoped
`human_decision` records behind one domain repository port.

## Keys and access

- Non-human kinds keep the unique key `(app_id, agent_folder, kind,
lookup_identity)` and the non-human `put | get | list | revoke` methods.
- An active human decision is unique by `(app_id, agent_folder,
acting_person_id, scope, scope_key)`. Human rows use only the typed
  `putHumanDecision | listHumanDecisions | revokeById` methods, each scoped by
  app, agent folder, and acting person.
- Human IDs are UUID v4 strings in the existing text `id` column.
- Human `lookup_identity` equals `scope_key`, `decision` equals `outcome`, and
  `principal` is the canonical tool name. Trust-growth counting groups active
  exact Allows by that `principal` value.

Exact No decisions use the full permission-effect hash. A single safe native
or virtual file-write Allow may instead use
`exact:path:<railVersion>:<canonicalTool>:<canonicalDestination>`. Kind keys
use `kind:<category>` or `kind:tool:<canonicalTool>`; place keys carry the
same kind identity as `place:<category>:<canonicalRoot>` or
`place:tool:<canonicalTool>:<canonicalRoot>`.

Interactive-auto requests with a resolved person consult an exact remembered
No before hard restrictions. Remembered Allows are consulted after the
non-overridable rails and trusted-root stage, in exact, tool kind, category
kind, tool place, then category place order, before the classifier cache.
Ask, auto-strict, and autonomous lanes do not consult human-decision memory.
Every lookup filters to the current rails version; rows written under another
rails version are inert.

## History and provenance

Writing the same active person/scope key refreshes that row and retains its ID.
After revocation, a later write inserts a new UUID row; revoked history is never
reactivated. Human provenance is the typed `human_decision:` codec carrying the
stored ID, acting person, outcome, scope, and rail version.

## Physical naming deviation

Context is King: the new physical columns deliberately use the table's existing
snake_case convention (`outcome`, `scope`, `scope_key`, `acting_person_id`,
`acting_person_label`) instead of the constitution's camelCase default. Drizzle
properties remain camelCase at the TypeScript boundary.
