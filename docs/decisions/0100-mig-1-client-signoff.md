---
status: accepted
confirmed_by: "vrknetha"
date: 2026-07-29
---

# MIG-1 Client Signoff

## Context

Developers currently create Postgres migration SQL and maintain Drizzle's
migration metadata manually. Sequential filenames collide across branches and
need renumbering after pulls or rebases.

## Decision

Use the installed Drizzle Kit to generate migration SQL and metadata with
timestamp prefixes, and validate migration history in the existing CI workflow.
Keep the existing runtime migration and deployment path unchanged.

## Consequences

Developers review generated SQL instead of assigning migration numbers by hand.
Custom SQL remains available through Drizzle's native custom-migration option.
Parallel schema changes may still require regeneration after a rebase, but
filename numbering is no longer manually coordinated.
