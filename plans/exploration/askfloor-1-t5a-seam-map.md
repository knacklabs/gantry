## 1. Shared permission-card seam

`apps/core/src/channels/permission-interaction.ts:74-88` — `permissionButtonLabel` — today labels scalar modes as “Allow once”, “Cancel”, and “Allow for future”; T5a must render the eligible-card order and labels from a new remember-aware affordance model while leaving scalar/ineligible behavior unchanged.

`apps/core/src/channels/permission-interaction.ts:90-130` and `:191-307` — text/native prompt construction — both call `formatPermissionContextLines`; T5a must add eligible pre-tap scope lines here so plain text and all native renderers agree.

`apps/core/src/channels/permission-interaction.ts:133-163` — `formatPermissionReceiptText` — emits current post-tap receipts; T5a must add remembered Allow/No and fallback receipt wording here.

`apps/core/src/channels/permission-interaction.ts:350-383` — `formatPermissionContextLines` — currently emits agent, chat/job context, family coverage, promotion hint, and self-approval notice; it is the shared pre-tap insertion point.

`apps/core/src/application/permissions/human-decision-learning.ts:24-44,97-119` — `PermissionRememberContext` — the host-derived context carries eligibility, lane, person, candidate keys, and `kindVariant`; it is persisted in the pending-interaction payload, not exposed on `PermissionApprovalRequest`.

`apps/core/src/application/interactions/pending-interaction-permission-callback.ts:448-469` — `rememberSettlementForClaim` — reads the persisted `rememberContext` only at settlement. T5a needs a narrow render-time carrier/hydration path; provider callback text must not become the authority source.

`apps/core/src/application/permissions/human-decision-learning.ts:231-248` — candidate selection — place currently refuses as `no_root`, and `kindVariant: 'tool'` selects the trust-growth key. T5a must supply a validated root for place and set `kindVariant: 'tool'` only after the three-Allow condition.

## 2. Batch seam

`apps/core/src/channels/permission-batch-coalescer.ts:98-106` — `permissionBatchButtonLabel` — today renders “Allow all / Review each / Deny all”; T5a must preserve those once-only actions.

`apps/core/src/channels/permission-batch-coalescer.ts:121-139` — `formatPermissionBatchPromptText` — text batches place rows immediately before the wait line; T5a must insert the specified once-only explanation there.

`apps/core/src/channels/permission-batch-coalescer.ts:142-161` — `buildPermissionBatchPromptParts` — native Slack/Discord batches use `contextLines: []`; T5a must put the same explanation in those context lines.

`apps/core/src/channels/permission-batch-coalescer.ts:66-82` — batch settlement — maps “Review each” to a non-repeatable result; no memory write should be added to this path.

## 3. Provider render and settlement seams

**Telegram.** `apps/core/src/channels/telegram/channel-prompts.ts:218-225` and `prepared-permission-card.ts:47-56` render one button per scalar `permissionDecisionOptions` entry. `apps/core/src/channels/telegram/channel-shared.ts:52-79` already encodes/parses all four remember codes, but `callback-handlers.ts:696-743` runs the result through scalar-only `normalizePermissionAction`. T5a must render remember codes, bind the rendered codes, decode them through the durable claim path, and add `memory_forget` rendering/dispatch.

**Slack.** `apps/core/src/channels/slack/permission-approval-delivery.ts:64-75,183-200` renders scalar options using central labels. `permission-action-id.ts:8-22` already registers remember-code action IDs, but `channel-interactions.ts:333-360` normalizes the submitted decision as scalar before claiming. T5a must preserve the structured code through claim/recovery and extend the Slack message-action renderer/handler, registered at `channel-interactions.ts:618-621`, for Forget.

**Discord.** `apps/core/src/channels/discord/interactions.ts:161-182` and `prepared-permission-card.ts:45-51` render the central scalar options. `components.ts:129-149` only constructs/parses scalar custom IDs, and `permission-callback.ts:44-95` claims the parsed scalar mode. T5a must widen this codec and callback flow for remember codes, plus extend `discordActionComponents`—which presently accepts only stop, job-permission, and scheduler actions at `components.ts:31-83`—for Forget.

**Teams.** `apps/core/src/channels/teams/cards.ts:168-213` renders scalar `Action.Execute` buttons. `permission-submit.ts:4-34` rejects anything scalar normalization does not accept, and `interaction-handlers.ts:230-372` settles only that scalar result. T5a must widen render/parse/settlement for remember codes and add Forget action handling.

## 4. `memory_forget` action seam

`apps/core/src/domain/message-actions.ts:3-64` — affordance union — has no `memory_forget` member. T5a must add a provider-neutral affordance carrying the record id and display label; the callback path must carry the authenticated provider person identity, as existing callback inputs do at `:66-139`.

`apps/core/src/app/bootstrap/channel-message-action-router.ts:62-118` — host action router — is the narrow host-owned dispatch seam. It currently validates and routes known action kinds only; T5a should add Forget validation and a dedicated host handler here.

`apps/core/src/application/permissions/human-decision-memory-service.ts:199-205` — `HumanDecisionMemoryService.revoke` — is the required T3a service call. It delegates to person-scoped `revokeById`.

`apps/core/src/domain/ports/permission-decision-memory.ts:197-209` — `revokeById` and `countExactAllowsByTool` — defines the required app, agent-folder, acting-person, record-id axes and the possible revoke outcomes. There is no Forget settlement path today.

## 5. Teams primary-action cap

`apps/core/src/channels/teams/cards.ts:629-651` — per-item `ActionSet` renderer — documents that card-level primary actions exceed Teams’ cap above six and demonstrates the established per-row container pattern.

`apps/core/src/channels/teams/cards.ts:168-213` — permission cards still use card-level `actions`. T5a should follow the existing per-row `ActionSet` pattern for ten Forget buttons; no card chunking is technically required by the current renderer.

## 6. Risk and trust-growth inputs

`apps/core/src/domain/permission-deterministic-rails.ts:205-227` — destructive/protected classification — identifies destructive and protected-path asks before rendering.

`apps/core/src/domain/permission-deterministic-rails.ts:256-274` — risk mapping — maps destructive asks to the `destructive` category and protected paths to `secret`.

`apps/core/src/application/permissions/gantry-tool-risk.ts:59-85,117-163` — T2b typed native-risk table — classifies closed high-risk Gantry rows and protected virtual writes; it is the typed source for native tool risk, not a UI heuristic.

`apps/core/src/application/permissions/human-decision-memory-service.ts:208-214` — `countExactAllowsByTool` — already exposes the read T5a needs.

`apps/core/src/adapters/storage/postgres/repositories/permission-decision-memory-repository.postgres.ts:315-341` — repository implementation — counts active, person-scoped, exact Allow rows grouped by canonical tool. T5a does not need a new persistence read.

## 7. Ineligible lanes and parity coverage

`apps/core/src/application/permissions/human-decision-learning.ts:97-102` — eligibility — is limited to interactive-auto, no host job, a resolved person, and an effect hash.

`apps/core/src/application/permissions/human-decision-learning.ts:181-188` — settlement recheck — rejects non-eligible/non-interactive-auto contexts before learning.

`apps/core/src/channels/permission-decision-options.ts:12-32` — scalar fallback/options — is the existing shape that ask, auto_strict, job, group, and batch cards must retain byte-for-byte.

The unchanged provider render paths are Telegram `channel-prompts.ts:218-225`, Slack `permission-approval-delivery.ts:183-200`, Discord `interactions.ts:161-182`, and Teams `cards.ts:200-212`.

`apps/core/test/unit/channels/provider-affordance-parity.test.ts:118-205` — cross-provider suite — currently covers scalar round trips across all four providers and remember-code codecs only for Telegram and Slack; T5a should extend it for eligible, destructive, protected, batch, and each ineligible lane.

## 8. Tap-budget fixture

`apps/core/test/unit/runtime/askfloor-tap-budget-harness.ts:40-76` — `TapBudgetFixture` and replay result — provides host lane, command/tool input, trusted roots, classifier verdict, and tap counting.

`apps/core/test/unit/runtime/askfloor-tap-budget.test.ts:23-60` — S1/S2 — covers attachment birthright and remembered exact Allow through real claim/learn/apply.

`apps/core/test/unit/runtime/askfloor-tap-budget.test.ts:62-95` — S3 — covers stderr redirect and a hard-floor `find`.

T5a’s S4 should add destructive `rm -rf build` with a remember-allow claim, repeat it for zero additional taps, verify `rm -rf dist` still asks, then claim remembered No for the distinct exact command—as required by the T5a AC at `.factory/stories/ASKFLOOR-1/decomposition.json:1081-1085`.

## 9. Architecture-map ceilings

`scripts/architecture-map.json:18-19` — default ceiling — is 700 lines for files not explicitly listed.

`scripts/architecture-map.json:37-38` — exceptions — cap Slack `channel-interactions.ts` at 712 lines and Telegram `callback-handlers.ts` at 900 lines.

Accordingly, `permission-interaction.ts`, batch coalescer, Slack delivery/action files, Discord files, Teams cards/submission/interaction files, and `domain/message-actions.ts` use the 700-line default; the two named exceptions retain their explicit ceilings. The current shared card file is already close to that default boundary, so a small extracted affordance/formatter is the safe shape.

## 10. Existing suite ownership

`apps/core/test/unit/channels/permission-interaction.test.ts:272-345` owns central button-order and batch-result assertions.

`apps/core/test/unit/channels/permission-batch-coalescer.test.ts:567-585` owns batch Allow-all/Deny-all claim propagation.

`apps/core/test/unit/channels/provider-affordance-parity.test.ts:118-205` owns provider codec/parity coverage.

`apps/core/test/unit/runtime/ipc-interaction-handler.test.ts:269-281` owns durable remember-context eligibility, forged/ineligible, recovery, and double-delivery behavior.

`apps/core/test/unit/application/human-decision-memory-service.test.ts:400-467` owns person-scoped revoke and trust-growth count service behavior.

`apps/core/test/unit/runtime/askfloor-tap-budget.test.ts:23-95` owns the story tap-budget scenarios.

## OWNER QUESTIONS

The plan already fixes the primary labels/order, destructive/protected behavior, batch wording, immediate Forget behavior, remembered-No semantics, and Teams per-row ActionSets. The remaining visible choices are:

1. Scope display nouns for the shared formatter: recommend **“this exact action”**, **“this kind of action, anywhere”**, and **“only in `<folder>`”**. These match the existing scope semantics without exposing keys.

2. High-risk tool display in “Allow all `<tool>` actions”: recommend the existing human-facing tool label, with the canonical tool id kept out of card copy.

3. Forget-button label: recommend **“Forget `<shortId>`”** rather than ordinal-only “Forget 1”, so the visible control matches `/permissions all` identifiers and remains stable if the list is refreshed.
