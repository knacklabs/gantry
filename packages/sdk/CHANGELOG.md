# @gantry/sdk

## 0.4.0

- Updated SDK contracts for the clean capability, model defaults, and job capability requirement surfaces.
- Documented job `toolAccessRequirements`, `requiredMcpServers`, response `toolAccess`, and `client.models.preview()`.
- Removed compatibility expectations for retired control API shapes.

## 0.3.0

- Removed the v1 runtime settings client surface. Runtime configuration now lives in `settings.yaml` and app/channel/agent admin routes.
- Runtime event listing and waits are backed by the canonical Runtime Event Exchange.
