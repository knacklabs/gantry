# JSONB Runtime Payload Boundary

Date: 2026-05-18

## Status

Accepted

## Context

Gantry keeps canonical runtime concepts queryable as typed Postgres columns:
apps, agents, conversations, threads, messages, sessions, jobs, runs, and
memory records all expose explicit fields for routing, authorization, leasing,
resuming, deduplication, auditing, and joins.

Some adapter-owned payload columns were still stored as `text` even though the
runtime and repositories already treated their contents as structured JSON. That
forced repository code and expression indexes to cast those values back to
`jsonb` before filtering, indexing, or validating them.

## Decision

Use native Postgres `jsonb` for JSON-shaped runtime payload columns when the
payload is adapter-owned, metadata-like, or a value object that repositories
query, index, validate, or partially update.

Keep canonical runtime state in typed columns. Do not collapse messages,
sessions, jobs, memory items, permission records, provider connections, or
conversation bindings into generic JSON blobs.

The first conversion covers the P0 runtime payload columns:

- `messages.external_ref_json`
- `message_parts.payload_json`
- `message_attachments.external_ref_json`
- `provider_sessions.provider_ref_json`
- `provider_sessions.metadata_json`
- `agent_session_digests.metadata_json`
- `control_http_sessions.external_ref_json`
- `jobs.schedule_json`
- `jobs.target_json`
- `memory_items.value_json`
- `memory_items.source_ref_json`

Migrations cast existing values directly with `column::jsonb`; invalid JSON must
fail the migration loudly instead of being repaired or silently discarded.

## Consequences

Repository writers for converted columns pass objects or arrays to Drizzle
`jsonb` columns, not pre-serialized JSON strings. Repository readers may accept
both parsed objects and legacy string-shaped test mocks at adapter boundaries.

Active code should not cast converted P0 columns back to `jsonb`. Historical
migrations may retain old casts because they describe earlier schema states.

Deferred payload columns remain `text` until separate focused slices convert
them with their own migration and verification.
