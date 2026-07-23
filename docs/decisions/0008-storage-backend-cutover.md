---
status: accepted
confirmed_by: "vrknetha"
date: 2026-04-21
---

# 2026-04-21 — App-Wide Storage Backend Cutover

## Context

Gantry runtime persistence, memory persistence, jobs, control events, and SDK callbacks need one production storage model. Public settings and docs must present Postgres as the runtime substrate.

We need a single cut to:

- keep runtime storage configuration under `storage.postgres.*`
- keep memory behavior settings under `memory.*`
- remove storage provider/profile branching and transition paths

## Decision

1. Runtime storage settings are configured in `settings.yaml` under `storage.postgres.*`:
   - `storage.postgres.url_env`
   - `storage.postgres.schema`
2. Memory records, chunks, embeddings, usage events, and audit events are stored in Postgres.
3. Storage provider/profile semantics are removed from active code/docs/CLI/skills.
4. Deprecated interfaces are removed with no fallback aliases.
5. No import/migration path is provided for prior local storage artifacts.
6. Postgres requires `pgvector`, `pg_trgm`, and `pg-boss` readiness.
7. Localhost Docker Postgres is supported for development.

## Alternatives Considered

- Add a local file-backed runtime:
  rejected because jobs, webhooks, memory search, and SDK control events need one production data model.
- Add temporary transition shims for removed keys:
  rejected due complexity and policy preference for clean cutovers in early-stage code.
- Auto-migrate previous memory DB into new schema:
  rejected; acceptable live impact and lower operational risk than one-off migration code.

## Consequences

- Runtime requires Postgres through `GANTRY_DATABASE_URL`.
- Health/diagnostics report Postgres capabilities explicitly.
- Local Dockerized Postgres is documented for development.
- Memory and session continuity state live in Postgres. Provider transcript
  exports live behind `ProviderArtifactStore`; local filesystem artifact storage
  is supported only through that adapter boundary.

## Rollback Or Migration Notes

- Rollback means restoring an earlier build and restoring old runtime storage files manually from backup.
- Product code does not include previous-schema DB import, transition readers, or automatic migration routines.
- Migration `0009_canonical_persistence_adapter_cut` is intentionally destructive and has no down migration; fresh local Postgres bootstrap is the supported path for this clean persistence cut.

## Supersedes

- Clarifies and extends [2026-04-17 — Settings And Runtime Truth](./0007-settings-runtime-truth.md) for storage backend selection and provider-era interface removal.
