---
status: accepted
confirmed_by: "vrknetha"
date: 2026-04-27
---

# Claude Runtime Materialization

## Status

Accepted.

## Context

Claude needs a filesystem config directory for settings, skills, and native
session files. Previous runtime setup generated shared durable files under
the runtime-home Claude directory, which made Claude-local files an implicit
runtime source of truth.

Enterprise Gantry must instead use canonical app, agent, config, skill refs,
permission, memory, session, and message state from Postgres, plus provider
artifacts behind `ProviderArtifactStore` and imported skill source artifacts
behind `SkillArtifactStore`.

## Decision

The Anthropic Claude adapter owns runtime materialization. For every Claude run
it creates a temporary `CLAUDE_CONFIG_DIR`, renders `settings.json`,
materializes local file skills, restores provider artifacts, runs Claude,
captures updated artifacts, and removes the temp directory.

Runtime startup no longer creates runtime-home Claude settings or syncs
runtime-home Claude skills.

Agent-created, admin-uploaded, catalog, URL, and CLI-command installs are saved
as draft skill artifacts. Draft metadata is durable in Postgres, source bytes
are durable behind a storage ref, and drafts are not materialized until a
user/admin approves and binds them.

## Consequences

- Claude runtime files are scratch files, not durable Gantry state.
- `settings.local.json` is not read in enterprise runtime.
- Host permission policy remains authoritative.
- Existing old local `.claude` files are not imported automatically.
- Local Claude skills remain files copied into per-run scratch config, either
  from bundled/configured folders or from approved bound artifacts.
- Hosted Anthropic skills are provider-managed resources used through the
  Anthropic SDK adapter; Gantry does not own hosted skill version approval.
