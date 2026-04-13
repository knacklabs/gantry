# Ops

## Scope

- `ops/bootstrap.sh` is the repo bootstrap entrypoint.
- `ops/launchd/` holds tracked service templates for macOS.

## Rules

- Ops scripts must resolve the repo root correctly from the `ops/` directory.
- Service identifiers, log names, and launchd filenames must stay on `myclaw` naming.
- If service behavior changes, keep the setup flow in `apps/core/setup/` and the tracked ops templates aligned.
