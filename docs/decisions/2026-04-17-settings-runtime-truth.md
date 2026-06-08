# 2026-04-17 — Settings And Runtime Truth

## Context

Gantry must present one runtime truth across runtime code, CLI, diagnostics, setup, docs, and shipped skills. Runtime behavior settings were previously split between `settings.yaml` and `.env`, which created conflicting states and unclear operator UX.

## Decision

1. Runtime mode is fixed to host runtime only.
2. `settings.yaml` is the canonical runtime behavior surface for non-secret settings.
3. `.env` is for secrets and channel credentials only.
4. Memory runtime behavior is controlled only by `settings.yaml`:
   - `memory.enabled`
   - `memory.embeddings.enabled`
   - `memory.embeddings.provider` (`disabled`, built-in provider ids, or registered provider ids)
   - `memory.embeddings.model`
   - `memory.dreaming.enabled`
5. `settings.yaml` is rendered as compact current desired state for humans:
   `defaults.*`, enabled `providers.*`, editable `agents.*`, and
   `conversations.*`. Advanced sections such as `provider_connections.*`,
   `storage.*`, `model_access.*`, `memory.*`, and
   `desired_state.authoritative` are omitted when they match built-in defaults.
   There is no versioned settings lane because Gantry is still early-stage.
6. `model_access.*` stores only non-secret model gateway configuration.
   Model provider keys live in typed encrypted model credential records, and
   `SECRET_ENCRYPTION_KEY` stays in runtime `.env`.
7. Runtime memory injection is query-scoped: the current message or scheduled
   job prompt drives retrieval, and no memory block is injected when nothing
   matches. Provider/session continuity remains separate from durable memory and
   memory tooling; commitment/inbox/digest controls are separate future work.
8. Local desired-state configuration uses `agents.<agentId>` for agent display
   and selected capabilities, while `conversations.<id>` owns provider
   conversation IDs, sender policy, trigger policy, control approvers, and the
   usual single-agent binding. It references approved catalog ids or aliases only; skill source
   bytes, MCP definitions, artifacts, messages, jobs history, browser profiles,
   memory records, and raw provider secrets stay out of `settings.yaml`.
9. Phase 1 desired-state reconciliation is additive/update-only. DB-only
   agents or bindings are reported as drift but are not removed. Phase 2 enables
   destructive reconciliation only when `desired_state.authoritative: true`.

## Consequences

- CLI mutation commands update `settings.yaml`.
- Agent-requested local configuration changes use reviewed Gantry admin tools.
  Only agents with selected admin tool capabilities can use
  `settings_desired_state` to inspect and `request_settings_update` to ask the
  host to validate and write a replacement file after approval. Settings
  updates carry the revision returned by `settings_desired_state`; stale
  revisions are rejected, and writes are atomic.
- Runtime watches `settings.yaml`; valid safe changes reconcile live, while
  storage, credential broker, and channel topology changes are reported as
  restart-required.
- `gantry status` and `gantry doctor` report memory/storage/embeddings/dreaming state from `settings.yaml`.
- Unsupported runtime and memory env keys are surfaced as warnings in doctor/config surfaces.
- Direct YAML edits remain first-class with strict validation and actionable path-level errors.

## Notes

- Runtime storage is Postgres via `GANTRY_DATABASE_URL`.
- Memory data is stored in Postgres.
- Session transcript archives are operational artifacts under runtime `data/`,
  not the memory store.
- Embeddings are optional and disabled by default.
- Dreaming is optional and disabled by default.
