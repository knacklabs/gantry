---
status: accepted
confirmed_by: "vrknetha"
date: 2026-04-27
---

# 2026-04-27 — Provider Artifact Store

## Context

Claude JSONL/session files were being treated as durable local runtime state.
That couples Gantry session continuity to one provider, one filesystem layout,
and one machine.

Canonical conversations and messages already live in Postgres. Provider files
must not be canonical history.

## Decision

Gantry stores explicit provider exports and debug artifacts through
`ProviderArtifactStore`.

- `local-filesystem` is supported for single-node production and shared-volume
  deployments.
- `postgres` is supported for small/bootstrap/test artifacts.
- `object-store` is the scale extension point for S3, R2, GCS, or MinIO.
- Artifact metadata, hash, size, ownership, deletion state, and latest pointers
  live in Postgres.
- Claude JSONL is not restored into runtime directories for resume.
- Markdown transcript export is an explicit `transcript-export` artifact.

No automatic import is provided for old local Claude JSONL files.

## Consequences

Runtime and provider code must not construct durable Claude JSONL paths
directly. If a provider export is needed, it must use `ProviderArtifactStore`.

Single-node deployments can use local filesystem artifact bytes. Multi-node
deployments need a shared filesystem or object-store adapter.

Provider artifacts are not a session continuity path. Active chat continuity
uses the live provider stream, and cold starts hydrate durable Gantry memory
only.
