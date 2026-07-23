---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-22
---

# Gantry Naming And Public Repo

## Context

The product was renamed to Gantry and the public repository moved. The
pre-adopt working contract (`docs/context/migrated-AGENTS.md`, Docs Rules)
fixed the naming policy so docs and metadata do not drift back to legacy
branding or moved URLs.

## Decision

User-facing and project-facing docs use `Gantry` naming. Public GitHub
repository metadata and clone URLs use
`https://github.com/cawstudios/Agent.Gantry`.

## Consequences

- Existing code identifiers, package names, CLI binaries, environment
  variables, paths, MCP tool names, and database schema names that still
  contain `gantry` are literal implementation names; they change only via an
  explicit rename task, never casually in docs or tests.
- Legacy branding and fork/upstream framing must not be reintroduced in
  active docs or instructions.
