# Ponytail Phase 4 Review

## P1 — Conversation-install responses still emit fields deleted from the public contract

`apps/core/src/control/server/routes/provider-conversation-mappers.ts:63`
still copies `subject.route.trigger` and `subject.route.requiresTrigger` into
`routeConfig`. The new canonical `ConversationInstallRouteConfigSchema`
contains only `agentConfig`, and the projected/generated type at
`packages/sdk/src/generated/openapi.ts:2216` therefore omits both fields.
This is reachable current behavior: desired-state reconciliation still writes
`memorySubject.route.requiresTrigger` for every configured install at
`apps/core/src/application/settings/desired-state-service.ts:556`.

Failure scenario: list/enable/update/disable can return
`routeConfig.requiresTrigger` (and older route subjects can return `trigger`),
but a generated SDK consumer cannot type-access those values and a consumer
that validates responses against the published schema will reject the payload.
The intended clean cut is to stop emitting install-level trigger policy from
`routeConfig`; restoring the fields to the contract would contradict the Phase
3/4 ownership move to Conversation.

## P1 — The generated install request advertises fields that the route silently discards

`apps/core/src/control/server/openapi-contract-schemas.ts:75` projects the
generic `ConversationInstallRequestSchema` for both path-based enable and
update operations. That schema includes `appId`, `agentId`, `conversationId`,
and `metadata` at `packages/contracts/src/providers/index.ts:124`, so all four
appear in the generated SDK request type. After parsing, however,
`conversationInstallPatchFromParsed` at
`apps/core/src/control/server/routes/provider-conversation-mappers.ts:252`
maps none of them; the authenticated app and path agent/conversation always win,
and metadata is simply lost.

Failure scenario: a typed SDK call can supply a different body `agentId` or
`conversationId`, or attach `metadata`, receive a successful response, and
observe that the request was applied to the path identity with metadata
discarded. Export and project a route-specific contract that omits path-owned
identity fields and unsupported metadata (or implement metadata persistence if
it is genuinely part of this operation).

## P2 — Model workload still has two schema authorities

`packages/contracts/src/jobs/index.ts:480` defines the enum inside
`ModelRecordSchema.supportedWorkloads`, while
`packages/contracts/src/jobs/index.ts:521` defines the same six values again as
`ModelWorkloadSchema`. Both are projected: `Model.supportedWorkloads` uses the
first definition and `ModelDefaultSlot.workload` uses the second. The generated
drift check cannot detect disagreement because both copies are valid inputs to
the same generation run.

Failure scenario: adding a workload to only one list produces a freshly
generated, CI-clean SDK in which a model can advertise a workload that a
default slot cannot represent, or vice versa. Define `ModelWorkloadSchema`
once before `ModelRecordSchema` and use it in `supportedWorkloads`.

## P2 — The model-list client still hand-mirrors the generated response envelope

`packages/sdk/src/openapi-types.ts:86` now exposes the generated
`ListModelsResponse`, but `packages/sdk/src/models.ts:17` still declares the
return as the handwritten `{ models: ModelRecord[] }` shape. This leaves one
F4 model operation outside the operation-alias flow used by defaults and
preview.

Failure scenario: if the public list response gains required pagination or
catalog metadata, regeneration updates `ListModelsResponse` while
`client.models.list()` continues to hide that field and still compiles. Type
the request with `ListModelsResponse` directly.
