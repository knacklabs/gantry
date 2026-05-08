# Provider Session Artifacts

Provider session artifacts are provider-owned export/debug files attached to a
canonical `AgentSession` and `ProviderSession`. They are not canonical
conversation history and are not runtime continuation state.

Canonical MyClaw state remains in Postgres:

- conversations, threads, messages, and message parts
- agent sessions and provider session metadata
- agent runs and run events
- summaries, memory, jobs, permissions, and control events

Provider artifacts hold provider-specific bytes for explicit export,
inspection, or debugging. Claude JSONL transcripts and session indexes may be
stored as artifacts, but the runtime does not replay them.

Artifact rows and files are not continuity state. They must not be used to
import old continuity, rebuild `AgentSession.scope_key`, create or backfill
session digests, repair missing provider-session rows, or override the current
provider-session ownership checks. Unsupported historical artifact layouts fail
closed: they can remain as inert debug/export material, but runtime resume and
fresh-run hydration ignore them.

## Artifact Store Contract

Runtime code reads and writes provider artifacts only through
`ProviderArtifactStore`.

Supported artifact kinds:

- `claude-jsonl`
- `claude-session-index`
- `provider-state`
- `transcript-export`

Supported storage types:

- `local-filesystem`: production-supported for single-node or shared-volume
  deployments
- `postgres`: small/bootstrap/test storage where content is stored in Postgres
- `object-store`: future S3/R2/GCS/MinIO-style storage

Every artifact records ownership, storage location, hash, size, creation time,
and metadata in Postgres. Provider latest artifact pointers are metadata only.

## Claude Runtime Flow

Claude runs use a temporary `CLAUDE_CONFIG_DIR` containing generated
`settings.json`, materialized `skills/`, and an SDK project scratch directory.
MyClaw does not restore `claude-jsonl` artifacts before a run, does not pass SDK
`resume` from artifact files, and does not capture SDK session files as durable
runtime truth after a run.

For live chat turns, the current Claude adapter may still pass a scoped
`ProviderSession.externalSessionId` to SDK `resume`; that handle comes from
canonical Postgres session metadata, not from replayed artifact files.

Session continuity uses a live SDK streaming-input query while the runner is
alive. Cold starts hydrate durable MyClaw memory only; canonical messages, runs,
and summaries are audit/observability state and are not replayed into prompts.
Current continuity is therefore governed by canonical `scope_key` resolution and
digest scope filtering, not by artifact filenames, provider transcript ids, or
legacy provider-session indexes.

## Local Filesystem Backend

The local filesystem backend stores artifact bytes under:

```text
<runtime-home>/artifacts/provider-sessions/
```

The adapter owns the exact layout, validates paths stay inside the artifact
root, and writes files atomically. Runtime and provider code must never build
durable Claude JSONL paths directly.

This backend is appropriate for one production node or a shared mounted volume.
Horizontal scaling requires either a shared filesystem with the same artifact
root mounted everywhere or an `object-store` adapter.

## Transcript Export

Markdown transcript exports are explicit artifacts with kind
`transcript-export`. They are not hidden durable runtime state under
`data/session-archives`.
