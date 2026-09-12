---
status: accepted
confirmed_by: "Ravi"
date: 2026-09-11
stories: [cache-bug]
---

# Physical database columns are snake_case

## Context

`constitution/pnp-database-standards.md:46` requires camelCase physical
column names. Every physical column in this repository is snake_case —
`agent_session_id`, `external_session_id`, `reset_at`, `metadata_json`, and
the rest — so the standard as written has never been followed here, and the
Drizzle schema maps camelCase TypeScript properties onto snake_case columns
throughout.

The cache-bug plan grill flagged the new `context_high_water_mark` column as
an undocumented constitution violation. It is not a new deviation: it is the
existing convention, applied consistently. But nothing recorded that the
convention deviates from canon, so a grill has no way to tell a deliberate
house style from an oversight, and every future story that adds a column
pays the same argument again.

## Decision

Physical column names in this repository are **snake_case**, deviating
deliberately from `pnp-database-standards.md:46`. TypeScript-side property
names stay camelCase; Drizzle performs the mapping. The standard's intent —
one consistent convention, mechanically checkable — is satisfied by
snake_case being applied without exception.

Changing the existing columns to camelCase is explicitly rejected: it would
require rewriting every migration, query and snapshot in the repository for
no behavioural gain, and would leave the database inconsistent with every
other Postgres schema the operators work with.

## Consequences

- A new column is named snake_case, and that is now a recorded choice rather
  than an unexplained divergence. Reviews and grills can cite this decision
  instead of re-raising the standard.
- `pnp-database-standards.md:46` and this repository disagree by design. The
  standard is canon for repositories that follow it; this decision is the
  local override, scoped to physical column names only — nothing else in
  that standard is set aside.
- If the constitution is ever revised to permit snake_case, this decision
  becomes redundant and should be retired rather than kept as a permanent
  exception.
