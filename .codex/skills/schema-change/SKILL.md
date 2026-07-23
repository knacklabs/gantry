---
name: schema-change
description: Use for Postgres schema, migrations, persistence repositories, and storage contract changes in Gantry.
---

# Schema Change

Use this skill when a task changes Postgres schema files, migrations, repositories, storage readiness, query contracts, or persisted runtime data shape.

## Required Workflow

1. Read `docs/decisions/2026-04-21-storage-backend-cutover.md`, `docs/architecture/current-verification-commands.md`, and relevant storage architecture docs before editing.
2. Keep Postgres as the runtime storage model for runtime state, jobs, control events, memory, and persistence repositories.
3. Update contracts, repository types, migrations, readiness checks, and docs when persisted shape or public behavior changes.
4. Use `settings-control-plane` when the database state mirrors `settings.yaml` desired state, and state whether Postgres is source of truth or projection.
5. Do not add migration compatibility commands, automatic old-state import flows, or cleanup shims unless a decision record explicitly approves them.
6. Add or update repository/storage tests that exercise reads, writes, and failure behavior for the changed schema.
7. Run the smallest relevant repository tests plus `python3 .agents/scripts/verify.py` before final handoff when possible.

## Evidence To Provide

- Migration/schema file changed.
- Repository contract updated.
- Tests proving persistence behavior.
