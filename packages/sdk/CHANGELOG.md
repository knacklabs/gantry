# @gantry/sdk

## 0.7.0

- Removed the retired `delegatedCompletionGate` and `interactionBudget` job
  controls. Use the generic `completionGate` and the caller-resolved tool
  configuration's `maxInteractions` limit.

## 0.6.1

- Added `client.models.credentials` for the existing list, put, patch, and
  disable model-credential control routes.

## 0.6.0

- Added app-scoped runtime-event list/stream with durable cursors.
- Added Agent.Tender job task controls for structured output, exact skills,
  caller-resolved tools, completion gates, budgets, timeouts, and model controls.
- Added agent reconciliation, access-document replacement, reviewed MCP
  capability registration, trace propagation, and model-routed chat completions.
- Kept all 0.4.0 APIs additive and unchanged.

## 0.4.0

- Updated SDK contracts for the clean capability, model defaults, and job capability requirement surfaces.
- Documented job `accessRequirements`, response `toolAccess`, and `client.models.preview()`.
- Removed compatibility expectations for retired control API shapes.

## 0.3.0

- Removed the v1 runtime settings client surface. Runtime configuration now lives in `settings.yaml` and app/channel/agent admin routes.
- Runtime event listing and waits are backed by the canonical Runtime Event Exchange.
