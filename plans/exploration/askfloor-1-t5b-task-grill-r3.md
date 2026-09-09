## BLOCKING

1. The initial `/permissions` list cannot stamp the agent-keyed authority required by ruling 3. The `remembered` dependency omits `agentId`, and AC2’s affordance also omits it (`askfloor-1-t5b-taskplan.md:14,28`), while routes may carry an explicit agent ID distinct from the folder-derived ID (`domain/types.ts:109-120`; `runtime-app-routes.ts:9-21`).
   Plan fix: add mandatory route-effective `agentId` to `SessionCommandDeps.remembered`, bind `group.agentId ?? agentIdForFolder(group.folder)`, and require it on every initial and replacement Forget affordance. Pin it in listing, group-processing, runtime-app, router, and provider tests.

2. Raw `{recordId, agentId}` cannot reliably fit provider callback limits. Telegram allows 64 bytes (`telegram/message-action-affordances.ts:42,136-143`); a UUID already consumes roughly 39 encoded bytes, while `agentIdForFolder` produces an unbounded `agent:<folder>` string (`domain/agent/agent-folder-id.ts:3-5`). Discord independently caps custom IDs at 100 characters (`discord/components.ts:19,49-53`).
   Plan fix: define a bounded, deterministic, collision-checked agent route key in `permission-memory-listing.ts`; transport `{full recordId, agentRouteKey}` and resolve it against route-effective agent IDs host-side. Add round-trip, maximum-size, unknown-key, and collision-fail-closed tests.

3. The 53-file write scope omits the actual callback codecs that must transport that route key. Telegram encodes/decodes Forget in `telegram/message-action-affordances.ts:70-85,134-150`; Discord does so in `discord/components.ts:42-58,102-116`; Teams emits the action data in `teams/cards.ts:66,309-329`. Conversely, `discord/interactions.ts` already spreads the parsed action and implements receipt-only behavior (`:297-309`), so it need not change.
   Plan fix: add Telegram `message-action-affordances.ts` and Teams `cards.ts`, replace Discord `interactions.ts` with Discord `components.ts`. That produces exactly 55 files, preserving the settled budget.

4. The proposed view ownership violates the layer contract. The plan says the application listing module owns `PermissionMemoryListMessageView`, but `domain/message-actions.ts` must reference it in `MessageActionOutcome` (`askfloor-1-t5b-taskplan.md:15-16,28,36-37`). Domain may import only domain/shared/contracts (`scripts/architecture-map.json:80-82`); the existing mirror type is domain-owned (`domain/message-actions.ts:1,177-190`).
   Plan fix: define/export `PermissionMemoryListMessageView` in `domain/message-actions.ts`; the application listing module constructs it but does not own its type.

5. The Forget handler lacks enough state to build the promised whole replacement message. Its dependency list has no permission-mode resolver (`askfloor-1-t5b-taskplan.md:16`), although the replacement includes the mode line and that line depends on override-or-default state (`session/session-commands.ts:580-585`). The plan also never requires a fresh active-only list after successful revocation.
   Plan fix: inject `resolvePermissionMode(route)`; after `revoke === applied`, re-read active current-rails rows, hydrate used-by data, and construct the complete current view. Test default mode, route override, and authoritative post-revoke re-listing.

6. Recoverable row reconstruction names fields/helpers that do not contain the required copy. Human rows persist `canonicalRoot: null` (`permission-decision-memory-repository.postgres.ts:186-205`); place is recoverable only from the encoded `scopeKey` (`human-decision-scope.ts:67-77`). No risk-category noun helper is exported from `permission-card-affordances.ts`, and its existing tool helper maps `Bash` to “exact command access,” not the ruling’s “Bash” (`permission-card-affordances.ts:209-227`; `permission-tool-labels.ts:4-6`).
   Plan fix: make the listing module decode category/place from `scopeKey`, add a closed category-noun mapping, and add a listing-specific exact-tool label mapping. Tests must use real T3-shaped rows with no `canonicalRoot`, including the literal Bash example.

7. The date formatter cannot guarantee the settled literal `2 Sep`. The plan specifies an undefined locale (`askfloor-1-t5b-taskplan.md:15`), whose field order and abbreviated month spelling vary by runtime locale.
   Plan fix: use a fixed-locale `formatToParts` operation and explicitly assemble `<day> <month>`; assert the exact string and the timezone day-crossing case.

8. The label carrier does not identify which message supplies `sender_name`, and the proposed single-message test cannot catch misattribution. Group processing has a generic latest message (`group-processing.ts:110-112`), while canonical identity deliberately selects the newest message matching the raw sender (`group-person-identity.ts:80-85,136-146`).
   Plan fix: derive `memoryUserLabel` from that same sender-matched inbound message, then add a trailing bot/different-sender test. The coordinator leaf must exercise `setupPermissionRunRestriction` from `AgentInput`, not only direct registry registration (`permission-decision-coordinator.test.ts:1185-1206`).

9. The provider leaves do not pin race-safe replacement behavior. Existing observer edits serialize by source message (`telegram/callback-handlers.ts:648-659`; `slack/channel-message-action-handler.ts:129-149`; `teams/message-actions.ts:378-396`), but AC4 names only edit/receipt assertions. Teams also has distinct authenticated `message.threadId` and source `replyToId` (`teams/types.ts:24-38`), while Discord’s receipt itself is an `@original` PATCH (`discord/interaction-helpers.ts:71-89`), making “no edit call” ambiguous.
   Plan fix: require the same per-message locks around Forget handler plus edit; use `message.threadId` for Teams routing and `replyToId ?? id` only for source-card mutation; phrase Discord’s test as “no source-list mutation, one ephemeral receipt update.” Add concurrent-click no-resurrection cases.

## NON-BLOCKING

- The `createGroupProcessor({...})` block is a coherent movable unit (`runtime-app.ts:574-661`), and `runtime-app.test.ts` can inspect its captured dependencies.
- Canonical-person resolution is cached, so the supplied thunk does not rerun identity (`group-person-identity.ts:11-29`). The plan’s `group-session-command-state.ts:69-124` citation is stale and should point there.
- `railVersion` can be made mandatory cleanly: the only production calls are `human-decision-memory-service.ts:160-164,181-188`, and the adapter filter belongs at `permission-decision-memory-repository.postgres.ts:215-234`.
- `createRuntimeSchedulerStarter` is feasible; the extracted closure is contiguous (`runtime-services.ts:372-433`), and existing tests already pin durable sends and provider-account resolution (`runtime-services.test.ts:2142-2239`).
- The accepted audit scan and `getJobById` hydration are implementable (`domain-repositories.postgres.ts:1808-1874`; `ops-repo.ts:221-225`). State explicitly that `UsedByJobReader` lives in the new listing module so it does not become a hidden 56th source file.
- `resolveConversationRoute` is in `app/bootstrap/runtime-app-routes.ts:9-21`, not `shared/thread-queue-key.ts:267-281`; the five-argument seam itself is real.
- Owner-level choices still open: none.

NOT CLEAN
