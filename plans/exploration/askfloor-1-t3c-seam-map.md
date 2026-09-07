# T3c seam map

Read-only exploration only; no files changed or tests run. All citations are from the specified T3b worktree.

## 1. Card-tap codec and durable reconstruction

- `apps/core/src/domain/human-decision.ts:13-49` — `PermissionRememberResolution` / `HumanDecisionRememberRequest` — T3a defines `{ kind: 'remember', outcome, scope }` and the service DTO, but production does not consume either — T3c must normalize eligible taps into this DTO without changing legacy modes globally.

- `apps/core/src/domain/types.ts:251-314` — `PermissionApprovalDecisionMode`, callback claim, recovery envelope — all durable card state is still scalar `allow_once | allow_persistent_rule | cancel` — T3c must preserve legacy mode semantics while carrying the structured remember selection through its owned codec.

- `apps/core/src/channels/telegram/channel-shared.ts:51-75` — Telegram callback codec — Telegram serializes and parses only scalar modes in `perm:<mode>:<id>` — T3c must add an eligible-card encoding that remains within Telegram’s compact callback format.

- `apps/core/src/channels/telegram/callback-handlers.ts:729-753` — Telegram permission callback — validates the scalar option, authorizes the provider user, then settles by scalar mode — T3c must decode the normalized remember resolution before this settlement path loses it.

- `apps/core/src/channels/telegram/permission-prompt-settlement.ts:35-63` — `claimAndSettleTelegramPermissionPrompt` — claims once, constructs `decisionForMode`, and releases the claim on failed settlement — T3c must keep the claim/release behavior while associating an eligible remember resolution with the settled decision.

- `apps/core/src/channels/slack/permission-action-id.ts:5-16` — Slack action IDs — action IDs enumerate only the three legacy scalar modes — T3c must extend the provider-side codec only for eligible cards.

- `apps/core/src/channels/slack/permission-approval-delivery.ts:64-75` — Slack button payload — button value persists `{ callback, decision: mode }` — T3c must encode a structured resolution or an opaque resolution token alongside the callback.

- `apps/core/src/channels/slack/channel-interactions.ts:228-264` — `claimAndResolvePermissionPrompt` — converts a scalar mode to a decision after the durable claim — T3c must route decoded remember data through this shared settlement choke point.

- `apps/core/src/channels/discord/components.ts:129-150` — Discord custom-ID codec — accepts only legacy scalar modes — T3c must add eligible remember decoding without widening normal-card controls.

- `apps/core/src/channels/discord/permission-callback.ts:44-95` — `handleDiscordPermissionCallback` — validates, claims, creates a scalar decision, and releases on failure — T3c must retain this once-only sequence while retaining the remember resolution.

- `apps/core/src/channels/teams/cards.ts:200-212` — Teams card actions — places scalar `decision: mode` in each action payload — T3c must encode its eligible structured resolution here.

- `apps/core/src/channels/teams/interaction-handlers.ts:237-363` — Teams callback handler — normalizes and validates a scalar decision before provider authorization and settlement — T3c must decode remember data before scalar normalization discards scope/outcome.

- `apps/core/src/application/interactions/pending-interaction-prompt-binding.ts:39-95` — `bindPendingPermissionInteractionMessage` — persists rendered scalar options and a request snapshot, but no resolution shape — T3c must persist enough codec state for recovery/replay to reconstruct the selected remember intent.

- `apps/core/src/application/interactions/pending-interaction-permission-callback.ts:292-405` — `claimPermissionInteractionCallback` — the durable claim records only `mode`, approver reference, timestamp, aliases, and scope — T3c must make a structured remembered resolution survive claim/replay or deliberately fail closed before learning.

- `apps/core/src/application/interactions/pending-interaction-permission-recovery-orchestrator.ts:102-209` — `recoverDurablePermissionDecision` — recovered callbacks reconstruct `decisionForMode` from the persisted scalar claim — T3c must replay the same remember intent exactly once, not downgrade it silently.

- `apps/core/src/adapters/storage/postgres/repositories/worker-coordination-permission-prompt.postgres.ts:420-436` — durable claim settlement — updates only the claimed prompt and accepts an already-settled claim idempotently — T3c must preserve this settlement fence for any codec storage change.

## 2. Human-resolution chokepoints

- `apps/core/src/runtime/ipc-interaction-processing.ts:132-158` — `processPermissionInteractionIpc` host identity stamp — overwrites worker `personId` from the host run restriction and clears it without one — T3c must use this host-authoritative value, never a callback-supplied identity.

- `apps/core/src/runtime/ipc-interaction-processing.ts:240-250` — replay-or-resolve branch — obtains the final permission decision but exposes no lane analysis, effect hash, canonical root, remember eligibility, or structured resolution — T3c must re-derive the lane and obtain the memory-write inputs at this boundary.

- `apps/core/src/runtime/ipc-interaction-processing.ts:269-340` — authority application and promotion recording — applies the current decision before the existing human-promotion signal — T3c must add learning without replacing the current-request application path.

- `apps/core/src/runtime/ipc-interaction-processing.ts:341-358` — decision recording — records non-permanent decisions after successful authority application — T3c must invoke memory learning only after the applicable claim/application safety boundary.

- `apps/core/src/app/bootstrap/inline-agent-loop-tools.ts:360-398` — inline request construction and coordination — stamps non-scheduled `run.memoryUserId` into `senderId` and `personId`, supplies T3b memory inputs, and disables classifier-cache reuse — T3c must preserve those stamps and re-derive the inline lane for settlement.

- `apps/core/src/app/bootstrap/inline-agent-loop-tools.ts:483-543` — inline durable interaction / `afterDecision` — has the request, run, and final decision before durable finish, but receives no structured resolution or `HumanDecisionMemoryService` — T3c must make this the inline write chokepoint and inject the service/port inputs it needs.

- `apps/core/src/application/interactions/durable-interaction-handler.ts:143-211` — `runDurablePermissionInteraction` — invokes `afterDecision` after the provider result and releases the callback claim if that hook throws — T3c must keep a refused or failed remember write from bypassing claim settlement or current-request behavior.

## 3. Existing replay and once-only guards

- `apps/core/src/application/interactions/pending-interaction-permission-claim.ts:40-60` — `samePermissionClaim` / approver validation — checks claim identity and rejects reserved approver names for allows — T3c must leave these forged-callback controls intact.

- `apps/core/src/application/interactions/pending-interaction-permission-callback.ts:359-397` — durable claim acquisition — a non-open or already-claimed prompt is `already_decided`, not a second resolution — T3c must ensure a replayed remember callback cannot write twice.

- `apps/core/src/application/interactions/pending-interaction-permission-callback.ts:470-549` — recovered settlement — validates each member, applies authority, then resolves the durable row with the same claim — T3c must have replayed remember writes fall behind this guard.

- `apps/core/src/application/interactions/pending-interaction-permission-recovery-orchestrator.ts:123-209` — recovered-card terminalization — a later tap uses the settled claim’s outcome rather than producing a new authority decision — T3c must not learn again on `already_decided`.

- `apps/core/src/application/interactions/durable-interaction-handler.ts:197-210` — inline after-decision ordering — hook failure releases the callback claim before durable finish — T3c must decide whether a memory-port failure is fail-open for the current once-only result or retryable before settlement.

## 4. Applying the current request

- `apps/core/src/domain/permission-decision.ts:99-128` — `permissionProvenance` — human scalar decisions become `human_once` unless they are persistent-rule decisions — T3c must map a remembered Allow to the current request’s once-only approval without accidentally issuing a durable tool rule.

- `apps/core/src/runtime/ipc-interaction-processing.ts:269-325` — `applyPermissionInteractionDecision` — the IPC path applies the current authority decision before telemetry, response, and durable resolution — T3c must preserve this exact application sequence.

- `apps/core/src/runtime/ipc-interaction-processing.ts:359-382` — resumed/current-call events — approved decisions publish resumed and final outcome events — T3c must leave remembered and once-only taps observationally equivalent for the current call.

- `apps/core/src/application/interactions/pending-interaction-permission-callback.ts:503-549` — replay authority application — a recovered scalar decision still applies the current member request before durable resolution — T3c must preserve this for a recovered remembered tap.

- `apps/core/src/app/bootstrap/inline-agent-loop-tools.ts:543-560` — inline return path — the resolved decision is returned to the tool gate after promotion recording — T3c must retain this return behavior when adding learning.

## 5. Person resolution and unresolved identity

- `docs/decisions/0118-identity-scoped-approval-and-grants.md:37-52` — acting-person contract — live DM identity is host-stamped `memoryUserId`; scheduled identity comes from job context; workers do not supply it — T3c must use the same authority source.

- `apps/core/src/application/interactions/pending-interaction-permission-envelope.ts:10-56` — `durablePermissionRequestSnapshot` — persists the request’s `personId` across recovery — T3c must treat this as request identity, not proof of the person who tapped.

- `apps/core/src/channels/telegram/callback-handlers.ts:756-811` — Telegram approver lookup — resolves only a provider user ID and control-approver authorization — T3c must add or receive a typed human-person resolution before learning.

- `apps/core/src/channels/discord/permission-callback.ts:50-84` — Discord approver lookup — obtains provider `userId`, checks authorization, and stores it as `approverRef` — T3c must not equate that opaque provider ID with `personId`.

- `apps/core/src/channels/teams/interaction-handlers.ts:326-364` — Teams approver lookup — validates provider `userId` and passes it as `approverRef` — T3c must similarly resolve a human person or refuse remembering.

- `docs/decisions/0154-human-decision-memory-generic-scope.md:14-21` — human-memory eligibility — unresolved people and groups never learn; their taps act once-only — T3c must fail closed to legacy scalar settlement when person resolution is absent.

## 6. S2 tap-budget fixture

- `apps/core/test/unit/runtime/askfloor-tap-budget-harness.ts:13-36` — `TapBudgetFixture` — supports lane, command/tool input, classifier stub, and attachment facts, but has no person, decision-memory repository, or remembered-card response input — T3c must add only the fixture controls required for first tap/persist/second reuse.

- `apps/core/test/unit/runtime/askfloor-tap-budget-harness.ts:42-138` — `replayPermissionRequest` — invokes the live IPC decision seam and counts prompt calls — T3c can use this existing harness for S2, with a stateful eligible approval and memory repository.

- `apps/core/test/unit/runtime/askfloor-tap-budget.test.ts:22-85` — existing S1/S3 cases — S1 proves all-lane attachment birthright and S3 proves interactive-auto classifier routing; there is no S2 fixture yet — T3c must add `cd ~/Workdir/<repo> && ls && git log`: first run at most one tap, persisted allow, second run zero taps.

- `apps/core/test/unit/runtime/permission-human-memory-stage.test.ts:80-139` — consultation contract — already pins interactive-auto-only lookup and exact/kind/place candidate ordering — T3c’s S2 write must use keys that this stage can find.

## 7. Eligible and excluded lanes

- `apps/core/src/application/permissions/auto-lane-analysis.ts:97-114` — `deriveAutoLaneAnalysis` — derives `InteractiveAuto`, `AutoStrict`, `Ask`, or `Autonomous` from permission mode and host job ID — both settlement chokepoints must use this function rather than infer a lane.

- `apps/core/src/runtime/permission-human-memory-stage.ts:91-102` — `eligiblePerson` — consultation requires interactive-auto, memory port, effect hash, and nonblank request person — T3c’s write eligibility must match these rails.

- `apps/core/src/runtime/permission-decision-coordinator.ts:107-120` — coordinator entry — remembered exact Deny is consulted first with the typed lane analysis — T3c must generate compatible identity, effect hash, and rail-version data.

- `apps/core/src/runtime/permission-decision-coordinator.ts:227-254` — remembered Allow stage — Allows are considered only after non-overridable rails and before classifier cache — T3c must not persist an Allow that this stage cannot legally reuse.

- `apps/core/src/app/bootstrap/inline-permission-memory.ts:18-45` — inline memory inputs — derives an autonomous lane for scheduled inline runs and only uses `memoryUserId` for non-scheduled runs — T3c must refuse inline job learning and missing-person learning.

- `apps/core/src/runtime/ipc-interaction-processing.ts:141-158` — IPC job/person handling — distinguishes host-verified scheduled runs from interactive requests — T3c must refuse job learning at this host boundary.

- `apps/core/src/domain/human-decision.ts:35-49` — remember DTO — has no `rememberEligible` stamp; repository search found no production `rememberEligible` symbol — T3c must introduce and carry an authoritative eligibility fact from prompt construction through callback/recovery.

## 8. Architecture limits and layer rules

- `scripts/architecture-map.json:13-59` — line budgets — default source-file ceiling is 700 lines; exceptions relevant to T3c are `ipc-interaction-processing.ts` 865, `inline-agent-loop-tools.ts` 750, `telegram/callback-handlers.ts` 900, `slack/channel-interactions.ts` 712, and `slack/permission-approval-delivery.ts` 732 — T3c must split rather than grow files beyond those ceilings.

- `scripts/architecture-map.json:108-189` — layer map — domain may import only domain/shared/contracts; application may import domain/application/shared/contracts; runtime may import application; adapters/channels may import application but not runtime — T3c must keep the memory service application-owned and inject it into runtime/adapter settlement seams.

- `apps/core/src/runtime/ipc-interaction-processing.ts:1-68` — current IPC module — already sits at its explicit 865-line ceiling — T3c should add a narrowly named helper/module rather than inline a large settlement implementation.

- `apps/core/src/app/bootstrap/inline-agent-loop-tools.ts:590-668` — inline dependency wiring — already has only five lines below its 750-line ceiling and forwards the decision-memory repository — T3c should add a small injected helper, not substantial new inline logic.

## Open questions

1. What durable representation should bind `{ outcome, scope }` to a claimed callback so provider retry and post-restart recovery replay the same remembered decision without expanding the legacy mode union?

2. Which host-owned resolver maps an authorized provider tapper to a human `personId` and display label, and where is it injected into all four provider settlement paths?

3. Should failed memory persistence after a valid, claimed eligible tap preserve the current once-only approval and log an unlearned outcome, or leave the interaction retryable before settlement?

4. What exact prompt-stage producer stamps `rememberEligible`, including explicit exclusions for ask, auto_strict, group, batch, and job cards, so recovery can reject forged remember payloads without relying on card copy?
