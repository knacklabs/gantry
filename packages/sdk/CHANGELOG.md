# @gantry/sdk

## Unreleased

- Added typed `client.llm.chatCompletions()` support with safe request, model
  alias, route, and provider correlation metadata.
- Added HTTP status codes to `GantryError` for reliable retry classification.

## 0.5.0

- Added app-owned agent selection and canonical `executionContext` to session
  ensure responses for direct job handoff.
- Added typed model credential list, set, and disable operations for scoped
  deployment reconciliation.
- Added durable app-scoped runtime event list/stream APIs with cursor replay.
- Added explicit per-turn model aliases for SDK session messages.

## 0.4.0

- Updated SDK contracts for the clean capability, model defaults, and job capability requirement surfaces.
- Documented job `accessRequirements`, response `toolAccess`, and `client.models.preview()`.
- Removed compatibility expectations for retired control API shapes.

## 0.3.0

- Removed the v1 runtime settings client surface. Runtime configuration now lives in `settings.yaml` and app/channel/agent admin routes.
- Runtime event listing and waits are backed by the canonical Runtime Event Exchange.
