# Ops

## Scope

- `ops/bootstrap.sh` is the repo bootstrap entrypoint.
- `ops/launchd/` holds tracked service templates for macOS.

## Rules

- Ops scripts must resolve the repo root correctly from the `ops/` directory.
- Service identifiers, log names, and launchd filenames must stay on `gantry` naming.
- If service behavior changes, keep the tracked ops templates and CLI service manager behavior aligned.
- Public fleet/support ingress must require TLS. Do not add HTTP forwarding for `/v1/*`, webhooks, or any control-plane path; HTTP may only redirect to HTTPS.
- ECS task definitions must inject secret environment variables with `secrets` entries backed by Secrets Manager ARNs; keep plaintext `environment` entries to non-secret deployment knobs such as `GANTRY_PROCESS_ROLE`.
- ECS deployment role layouts are `api-only`, `chat-only`, `jobs-only`, and `all`; the control service may attach the control/API target group, and the live-worker service may attach the webhook ingress target group.
