No standalone T5b task-plan file exists in this worktree; this map is therefore grounded in the active story’s T5b ownership bullet, spec, and accepted decisions. T5b is specifically the `/permissions` task and must not reopen T5a provider rendering ownership. [plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md:195](<plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md:195>)

## 1. Command grammar

`apps/core/src/session/session-command-parse.ts:25-39` — `SessionCommand` / `parsePermissionsCommand` — supports only bare show, three mode values, and `default`. — Add typed `permissions_all` and `permissions_forget { prefix }`, accepting only the specified `forget` form and leaving mode parsing intact. Existing parser coverage is `apps/core/test/unit/session/session-commands.test.ts:186-210`.

## 2. Session-command rendering and dependency

`apps/core/src/session/session-commands.ts:89-135` — `SessionCommandDeps` — carries only permission-mode getters/setters; `apps/core/src/session/session-commands.ts:580-585` renders only the mode line. — Inject one host-owned `HumanDecisionMemoryService`, retain the mode line, then render the DM rows, empty state, ten-row footer, all-record plain text list, and prefix-resolution replies.

`apps/core/src/application/permissions/human-decision-memory-service.ts:181-205` — `list` / `revoke` — already returns active person-scoped rows and delegates exact-ID revocation. — T5b should format these rows; it should not add a second store or bypass the service. The existing short-ID/collision behavior is pinned at `apps/core/test/unit/application/human-decision-memory-service.test.ts:400-468`.

## 3. Caller identity and group variants

`apps/core/src/runtime/group-processing-session-command-handlers.ts:33-67` — `createGroupProcessingSessionCommandHandlers` — has `appId`, route/folder, conversation metadata, and lazy `memoryUserId`; `:146-153` supplies permission-mode dependencies. — Thread app, agent folder, resolved canonical person, and DM/group state into the session-command dependency.

`apps/core/src/runtime/group-person-identity.ts:136-192` — `resolveCanonicalMemoryPersonId` — resolves host-side identity, passes the provider display name to resolution, and returns a memory person only for eligible DMs. — Use this host-derived axis; every group form must be non-mutating and send the story’s specified DM guidance. [plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md:195](<plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md:195>)

## 4. `memory_forget` host handler and edits

`apps/core/src/app/bootstrap/channel-message-action-router.ts:76-120` — `setMemoryForgetHandler` — validates and routes typed Forget actions, but returns “Not available yet.” when unbound. — Bind one host handler which resolves the callback user to the canonical person, loads that person’s record before revocation to build `Forgot: <scope>`, then calls person-scoped `revoke`.

`apps/core/src/app/bootstrap/channel-wiring-types.ts:238-249` and `apps/core/src/app/bootstrap/channel-wiring.ts:741-747` — `ChannelWiring` action setters — expose review/observer/brain setters but not the Forget setter. — Add the Forget setter to this boundary before `runtime-services` can bind the host handler; `apps/core/src/app/bootstrap/runtime-services.ts:141-145` already has access to the decision-memory repository dependency.

`apps/core/src/domain/message-actions.ts:112-118` — `MemoryForgetMessageActionInput` — transports conversation, provider account, thread, authenticated provider user, and record ID, but no source message ID. — The callback identity is available, but host-only code cannot edit the source list message.

Provider capability seams exist, but T5a’s current Forget branches only acknowledge/ephemerally reply: Telegram `apps/core/src/channels/telegram/callback-handlers.ts:492-512`; Slack `apps/core/src/channels/slack/channel-message-action-handler.ts:108-127`; Discord `apps/core/src/channels/discord/interactions.ts:281-305`; Teams `apps/core/src/channels/teams/message-actions.ts:286-303`. Existing edit APIs are Telegram `editMessageText` (`apps/core/src/channels/telegram/callback-handlers.ts:556-565`), Slack `chat.update` (`apps/core/src/channels/slack/channel-message-action-handler.ts:226-239`), Discord message mutation (`apps/core/src/channels/discord/index.ts:188-206`), and Teams `updateAdaptiveCard` (`apps/core/src/channels/teams/message-actions.ts:242-249`). — The “edit in place where supported” requirement conflicts with the story statement that T5b touches no provider files; it needs an explicit scope decision.

## 5. “Used by job” read model

`apps/core/src/domain/ports/repositories.ts:613-618` — `PermissionRepository` — can save/get a decision only; it cannot list decisions by `actorContext.humanDecisionRecordId`. — Add one typed read contract keyed by that audit value.

`apps/core/src/application/permissions/permission-management-service.ts:489-521` — `recordDecision` — stores `jobId` and arbitrary audit metadata in `actorContext`; `apps/core/src/runtime/ipc-interaction-processing.ts:332-345` writes `humanDecisionRecordId` on the IPC lane; `apps/core/src/app/bootstrap/inline-permission-memory.ts:83-103` does the same for inline scheduled projection. — Query these durable audit rows, not runtime events, and show only jobs that actually consumed the memory record.

`apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts:1807-1867` — Postgres permission decision adapter — persists and restores `actorContextJson`. — Implement the typed query here. Hydrate job names through the existing job repository capability, `apps/core/src/domain/repositories/ops-repo.ts:221-225`.

## 6. Operating guidance

`apps/core/src/application/agents/prompt-profile-service.ts:199-220` — `FULL_TOOL_ACCESS_GUIDANCE` — is the active operating-guidance list. — Add the single `/permissions` direction here, not to runner-local `admin_permission_list`.

`apps/core/src/application/agents/prompt-profile-service.ts:242-252` — `OPERATING_GUIDANCE_BLOCK` — composes that list and has a truncation guard in `apps/core/test/unit/runtime/prompt-profile.test.ts:301-307`. — Update the guard expectation if necessary.

## 7. Approver label

`apps/core/src/domain/ports/permission-decision-memory.ts:34-58` — `PermissionDecisionMemoryRow` — persists optional `actingPersonLabel`; `apps/core/src/adapters/storage/postgres/schema/schema.ts:75-84` maps it to `acting_person_label`. — Rows must render the stored label verbatim, never “you”; decision 0154 specifies fallback “someone.” [docs/decisions/0154-human-decision-memory-generic-scope.md:14](<docs/decisions/0154-human-decision-memory-generic-scope.md:14>)

`apps/core/src/runtime/permission-remember-settlement.ts:86-112` and `apps/core/src/app/bootstrap/inline-permission-memory.ts:117-135` — prompt-context construction — pass a person ID but no `personLabel`, although the learning context accepts and persists it (`apps/core/src/application/permissions/human-decision-learning.ts:54-65,203-219`). — This is the gap: both paths currently create label-less records. The trusted host source is the inbound message’s `sender_name`, already supplied to identity resolution at `apps/core/src/runtime/group-person-identity.ts:136-147`; preserve it through the host context rather than trusting a worker value.

## 8. Listing and S5 fixtures

`apps/core/test/unit/runtime/askfloor-tap-budget-harness.ts:332-397` — `inMemoryDecisionMemory` — supplies person-scoped in-memory rows but `revokeById` is hard-coded to `not_found`. — Extend the fixture with active/revoked state and real person-scoped revoke behavior.

`apps/core/test/unit/runtime/askfloor-tap-budget.test.ts:54-60` and `:98-120` — S2/S4 — prove current remembered replay and exact destructive memory; no S5 test exists. — Add the owned S5 sequence: remember in chat → job projection has zero cards → Forget → same job re-cards.

## 9. Architecture limits and boundaries

`scripts/architecture-map.json:18-19` — default source-file budget — 700 lines. — This applies to new T5b modules and unlisted files.

`scripts/architecture-map.json:25,34,58,62` — special ceilings — `channel-wiring` 790, `runtime-services` 1186, `session-commands` 740, and `prompt-profile-service` 783. — Those files are already at their ceilings or nearly so; make a small extracted module rather than grow a capped bootstrap/session file.

`apps/core/src/app/bootstrap/channel-wiring.ts:741-747` — runtime-to-channel binding boundary — is the correct one-way action-setter seam. — Keep session parsing/rendering in `session/`, host composition in bootstrap/runtime, and provider mutation in channels; do not make bootstrap import provider implementations.

## 10. Existing suite ownership

`apps/core/test/unit/session/session-commands.test.ts:186-210` — parser suite — owns `show/set/default`; extend for `all` and `forget`.

`apps/core/test/unit/runtime/group-processing.test.ts:1-24` — group-processing integration suite — owns caller/dependency/identity route behavior; add DM and all three group variants.

`apps/core/test/unit/bootstrap/channel-message-action-router.test.ts:170-196` — router suite — owns typed Forget routing and unbound behavior; add host binding/result cases.

`apps/core/test/unit/application/human-decision-memory-service.test.ts:400-468` — service suite — owns short IDs, person scoping, and revoke result propagation; retain it for prefix-resolution helper coverage.

`apps/core/test/unit/channels/{telegram.test.ts:5588,slack.test.ts:6511,discord/discord.test.ts:4298,teams/teams.test.ts:1811}` — provider suites — already own Forget transport. They must change only if the owner permits provider-side list edits.

## OWNER QUESTIONS

1. Deleted-job suffix: when an audit row points to a missing job, should the row omit it, display “used by a deleted job,” or retain a snapshotted job name? Recommended: omit it, because the contract promises actual named jobs and there is no snapshot field.

2. In-place Forget update: may T5b touch the four provider action handlers to remove the row where each provider can edit? Recommended: yes; otherwise the specified in-place update is not implementable from the host-only callback contract.

3. Date presentation: should `/permissions` use the runtime’s configured timezone and a date-only format, or a fixed locale? Recommended: configured timezone and date-only, matching “2 Sep.”

4. Job suffix ordering: when more than two jobs used a record, which two names are shown? Recommended: two most recently recorded uses, then `+N jobs`.

The specified group reply, unpaginated `/permissions all`, and missing-label fallback are not open: the story fixes the group wording and `/permissions all` behavior, while decision 0154 fixes the fallback to “someone.” [plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md:162,195](<plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md:162>)
