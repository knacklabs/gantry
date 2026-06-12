# Ops

## Scope

- `ops/bootstrap.sh` is the repo bootstrap entrypoint.
- `ops/launchd/` holds tracked service templates for macOS.

## Rules

- Ops scripts must resolve the repo root correctly from the `ops/` directory.
- Service identifiers, log names, and launchd filenames must stay on `gantry` naming.
- If service behavior changes, keep the tracked ops templates and CLI service manager behavior aligned.
- Public fleet/support ingress must require TLS. Do not add HTTP forwarding for `/v1/*`, webhooks, or any control-plane path; HTTP may only redirect to HTTPS.
