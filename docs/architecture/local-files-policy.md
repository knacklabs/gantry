# Local Files Policy

Local files are allowed only when their durability is explicit.

## Durable

- `settings.yaml` under runtime home for non-secret operator configuration.
- Provider artifact bytes under `<runtime-home>/artifacts/` when the
  `local-filesystem` backend is selected for single-node or shared-volume
  deployments.
- Skill source artifact bytes under `<runtime-home>/artifacts/skills/` when
  agent-created or admin-uploaded skill zips become drafts. Postgres owns the
  metadata, status, hash, storage ref, and bindings.
- Credential adapter files owned by their credential adapter.

## Temporary

- Per-run Claude `CLAUDE_CONFIG_DIR` directories.
- IPC files for active runtime processes.
- Build, test, cache, and verification output.

Temporary files may be deleted without losing canonical conversation history or
provider continuation state.

## Disallowed As Runtime Truth

- runtime-home Claude settings
- runtime-home Claude local settings
- runtime-home Claude skills
- runtime-home Claude projects
- `DATA_DIR/sessions/<group>/.claude`

Bundled package skills may remain in the repository/package as source assets,
but runtime materializes them into a temp directory instead of syncing them into
runtime home.

Approved bound skill artifacts may also be unpacked into per-run temp Claude
config. Draft, rejected, and disabled skill artifacts are durable but not
runtime inputs.
