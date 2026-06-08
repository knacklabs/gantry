# Local State Inventory

This inventory classifies local filesystem state by durability.

## Durable Local State

- runtime home `settings.yaml`: non-secret runtime settings.
- `<runtime-home>/artifacts/files/`: FileArtifact bytes when using the local
  filesystem artifact backend.
- `<runtime-home>/artifacts/skills/<skill-directory>/`: installed skill files
  when using the local skill backend. Each package contains `SKILL.md` plus
  referenced files and subfolders. This is the durable readable source for a
  skill; generated `.llm-runtime/.../skills` folders are scratch projections.
- Local credential files managed by their owning credential adapters.
- Postgres, not runtime-home files, stores external ingress records,
  invocations, nonces, jobs, sessions, messages, runtime events, outbound
  webhook delivery state, memory, and canonical app scope.

## Temporary Local State

- Per-run Claude `CLAUDE_CONFIG_DIR` directories under the OS temp directory.
  These include generated `settings.json` and materialized `skills/`.
- Packaged or explicitly configured local skill folders are copied into per-run
  Claude config as scratch input. They are not durable source-selection
  identity.
- Installed bound skill artifacts are unpacked into per-run Claude config as
  scratch input. Disabled artifacts are never unpacked.
- IPC input/output files for active runtime processes.
- Build, test, coverage, and generated verification artifacts.

Temporary state may be deleted without losing canonical conversation history or
Gantry-owned durable state. Active provider continuity is live-process only;
provider SDK files are not resume inputs.

## Unsupported Local State

Claude JSONL under runtime-local `.claude` or
`data/sessions/<group>/.claude` paths is unsupported runtime state. These paths
are not durable truth and are not a continuation mechanism.

Runtime-home Claude settings and skills are also unsupported as Gantry
configuration or skill truth.

No automatic migration is provided for unsupported local Claude files.

## Safe Cleanup

After building and restarting from the current checkout, confirm `gantry status`
before inspecting `~/gantry`. Stale generated logs, obsolete scratch session/job
snapshots, old provider transcript exports, and unused local hook/webhook
scratch files may be archived under
`~/gantry/cleanup-archive/<timestamp>/`.

Do not move or delete secrets, `settings.yaml`, Postgres data,
`artifacts/`, or active agent folders unless a reset was explicitly requested.
