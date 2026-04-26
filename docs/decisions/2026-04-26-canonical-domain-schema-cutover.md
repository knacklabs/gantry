# 2026-04-26 — Canonical Domain Schema Cutover

## Context

MyClaw is replacing the legacy runtime identity shape with the canonical app,
agent, channel installation, conversation, thread, message, session, run,
memory, job, permission, sandbox, workspace, and browser model.

Legacy runtime persistence used provider-facing conversation keys, group
registration records, and provider-session-only continuity as primary runtime
identity. Those concepts are implementation details and should not remain the
storage or domain contract.

## Decision

The canonical domain model is the active target for TypeScript domain contracts
and Postgres persistence. The cutover is intentionally breaking:

- new domain types are pure TypeScript under `apps/core/src/domain/**`;
- new shared primitives live under `apps/core/src/shared/**`;
- runtime storage is represented by canonical tables for apps, agents,
  channel installations, conversations, messages, sessions, runs, memory, jobs,
  permissions, tools, skills, sandboxes, workspace snapshots, and browser
  profiles;
- migration `0008_canonical_domain_schema_cutover.sql` removes legacy-owned
  runtime tables without preserving previous local data.

No automatic import path, compatibility reader, cleanup command, fallback alias,
or old-state migration is provided.

## Consequences

Existing local databases that contain the old runtime shape must be recreated
or migrated destructively. This is acceptable because MyClaw is still in an
early-stage clean-cut refactor period.

Provider adapters must normalize external identifiers into canonical
conversation, thread, message, and session records before application behavior
uses them. Provider SDK types and provider-specific credentials remain outside
the domain model.
