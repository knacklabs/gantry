# Issue 97: Architecture-Test Slice (Docs + Guardrails)

## Scope

This slice is docs and verification guardrails only. Runtime/provider/storage implementation behavior is unchanged in this change.

## Deterministic Outbound Delivery Contract

1. The runtime composes outbound text, structured prompts, and status updates through channel-neutral descriptors first.
2. Delivery is executed through channel adapters, not provider SDK calls from runtime/application/session/job layers.
3. Outbound persistence must record delivery status transitions (`sent`, `partially_sent`, `failed`) in durable message state and runtime events.
4. Partial delivery is explicit: if at least one chunk is delivered and a later chunk fails, the run records `partially_sent` instead of collapsing to generic failure.
5. Restart/retry flows must reconcile from persisted status and sent-part metadata; they must not assume in-memory completion.

## Provider Profile Semantics

- `Provider` is catalog metadata for adapter capabilities (Telegram, Slack, Teams, Web/App, WhatsApp target).
- `ProviderConnection` is an installed credentialed binding for one tenant/workspace/bot/app identity.
- `Conversation` and `ConversationThread` are canonical runtime routing identities; provider ids are adapter projections.
- Provider SDK call shapes, payload formatting, and chunking limits remain adapter-owned details.

## Approval Hard-Boundary Protocol

1. Permission policy decision is evaluated before risky execution and before any cross-boundary provider action.
2. Conversation approvers remain the user-facing approval authority for both DM/private and group/channel conversations.
3. Approval result is bound to the pending request context (agent + conversation + requested action scope), not treated as a global provider grant.
4. Missing/malformed/expired approval resolution fails closed.

## Partial-Delivery Recovery Contract

- Telegram chunking behavior uses adapter-owned split helpers and length limits.
- `PartialMessageDeliveryError` carries sent-part metadata so runtime/job delivery settlement can avoid duplicate retries after visible partial output.
- Recovery semantics:
  - delivered parts stay durable and user-visible,
  - unsent remainder can be retried from persisted state,
  - monitoring/audit surfaces can distinguish partial success from complete failure.

## Restart Reconciliation Contract

- On restart, runtime reconciliation must treat persisted delivery status as source of truth.
- In-flight runs that crash after sending one or more parts but before clean shutdown remain recoverable through persisted partial-delivery metadata.
- Reconciliation must avoid duplicate blind re-sends when durable state already records delivered parts.

## WhatsApp and Web Docs-Only Target Contracts

### WhatsApp

- Status in this slice: docs-only target contract.
- Required future adapter behavior:
  - normalize inbound payloads into canonical conversation/thread/message surfaces,
  - route outbound delivery only via channel adapter boundary,
  - honor deterministic delivery statuses (`sent`, `partially_sent`, `failed`),
  - use conversation approver protocol for permission-gated actions.

### Web/App

- Status in this slice: docs-only target contract.
- Required future adapter behavior:
  - model each user-visible chat as `Conversation` or `ConversationThread` with explicit mapping,
  - preserve same approval boundary and capability policy as other channels,
  - use durable outbound delivery/event flow and webhook-safe replay semantics.

## Surface Impact Matrix

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Unchanged by design | This slice only documents contracts and adds architecture verification guardrails. |
| `settings.yaml` | Unchanged by design | No desired-state/config schema changes. |
| Postgres/runtime projection | Read-only/observable | Docs specify delivery/reconciliation expectations against existing statuses/events. |
| Control API | Read-only/observable | Contracts clarified for SDK/webhook and approval semantics; no route changes. |
| SDK/contracts | Read-only/observable | Docs align SDK expectations; no contract type edits in this slice. |
| CLI | Unchanged by design | No CLI behavior or command-surface changes. |
| MyClaw MCP/admin skill | Unchanged by design | No capability/admin tool behavior changes. |
| Channel/provider adapters | Read-only/observable | Existing adapter boundaries are documented and verified; no implementation edits here. |
| Docs/prompts | Changed | New architecture-test slice and verification documentation updates. |
| Audit/events | Read-only/observable | `partially_sent` and delivery-state semantics are clarified, not changed. |
| Tests/verification | Changed | Add architecture guardrail for direct runtime provider send bypasses plus focused checker tests. |

## Verification Guardrail Added In This Slice

- `python3 .codex/scripts/check_architecture.py` now includes a direct provider-send bypass check for runtime/application/session/job/domain layers.
- Guardrail intent: fail when provider SDK send calls are used outside channel adapter paths.
- Current patterns are intentionally narrow to reduce false positives:
  - Telegram: `bot.api.sendMessage(...)`
  - Slack: `chat.postMessage(...)`
  - Teams: `sdkClient.sendMessage(...)`

## Stale-Reference Sweep Results (2026-05-08)

Intentional remaining active-code matches after the cross-slice repair pass:

- `PartialMessageDeliveryError`: domain partial-delivery carrier used by Telegram, Slack, and Teams adapters, jobs, runtime tests, and runtime settlement classification.
- `partially_sent`: canonical delivery status in domain/contracts/runtime wiring.

Removed active-code matches:

- Legacy Telegram text iterator/count helper names.
- Legacy runtime-local partial-delivery guard wrapper.
- Legacy Telegram draft max-length constant.

Direct send bypass sweep outcome for runtime/application/session/job/domain paths:

- No direct provider SDK send call matches were found in non-adapter runtime paths.

## Required Search Commands For This Slice

```bash
rg -n "iterTelegramTextChunks|countTelegramTextChunks|sendWithPartialDeliveryGuard|PartialMessageDeliveryError|TELEGRAM_DRAFT_MAX_LENGTH|partially_sent" .
rg -n "bot\.api\.sendMessage\(|chat\.postMessage\(|sdkClient\.sendMessage\(" apps/core/src/app apps/core/src/runtime apps/core/src/jobs apps/core/src/session apps/core/src/domain apps/core/src/application
python3 .codex/scripts/check_architecture.py
```
