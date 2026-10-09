Seven findings from a static, read-only audit. No files changed. The named UX-1 and PROV spec files are absent in this checkout; I applied the exclusions you supplied.

1. **Text splitting has four implementations, and Discord splits emoji — duplicate / UX**

   Discord cuts every 2,000 UTF-16 units. For `1,999 ASCII characters + 😀`, it separates the emoji’s surrogate pair into two messages. Slack, Telegram and Teams already avoid this.

   **Locations:** [Discord:55](../../../../apps/core/src/channels/discord/delivery.ts#L55), [Slack:8](../../../../apps/core/src/channels/slack/text-limits.ts#L8), [Telegram:18](../../../../apps/core/src/channels/telegram/channel-delivery-text-splitting.ts#L18), [Teams:15](../../../../apps/core/src/channels/teams/delivery.ts#L15). Discord’s reply path calls its splitter at [index.ts:186](../../../../apps/core/src/channels/discord/index.ts#L186).

   **Survive:** one Unicode-safe code-unit splitter, using the Slack implementation’s algorithm. **Merge/delete:** the four plain splitters; retain Telegram’s markup-aware splitting and Teams’ separate byte budget. **Size:** medium, a story including consumers and checks. **Risk:** preserve empty-message behavior, provider limits and Telegram’s nonpositive-budget handling.

2. **“Archived” provider accounts are merely disabled — parallel / UX**

   API and SDK clients see four status choices, but the product stores only `active` and `disabled`. Both `inactive` and `archived` become `disabled`; there is no distinct archival operation here.

   **Locations:** canonical [domain:34](../../../../apps/core/src/domain/provider/provider.ts#L34); aliases in [application patch:40](../../../../apps/core/src/application/provider-conversations/provider-conversation-control-use-cases.ts#L40), [normalizer:155](../../../../apps/core/src/application/provider-conversations/provider-conversation-control-use-cases.ts#L155), [contracts:10](../../../../packages/contracts/src/providers/index.ts#L10), [SDK:15](../../../../packages/sdk/src/provider-types.ts#L15), [OpenAPI schema:91](../../../../apps/core/src/control/server/openapi-schemas-admin.ts#L91), [generated OpenAPI:2953](../../../../packages/sdk/src/generated/openapi.ts#L2953).

   **Survive:** `active`/`disabled`, matching actual behavior. **Delete:** redundant spellings and their normalization; regenerate the public schema. **Size:** medium, a story because the public contract changes. **Risk:** clients using the advertised aliases must update.

3. **Slack repeatedly implements the same formatting safeguards — duplicate**

   Developers must maintain six equivalent escapers, four button truncators and two identical entity-safe truncators. Card types have their own copies of basic Slack rules.

   **Locations, every copy:**
   Escaping: [shared rich helper:47](../../../../apps/core/src/channels/rich-interaction.ts#L47), [todos:19](../../../../apps/core/src/channels/slack/agent-todo-blocks.ts#L19), [permissions:187](../../../../apps/core/src/channels/slack/permission-blocks.ts#L187), [brain reviews:95](../../../../apps/core/src/channels/slack/brain-review-affordances.ts#L95), [message actions:182](../../../../apps/core/src/channels/slack/message-action-affordances.ts#L182), [observer digest:19](../../../../apps/core/src/channels/slack/observer-digest-affordances.ts#L19).
   Button truncation: [questions:13](../../../../apps/core/src/channels/slack/channel-user-question-utils.ts#L13), [brain reviews:102](../../../../apps/core/src/channels/slack/brain-review-affordances.ts#L102), [message actions:63](../../../../apps/core/src/channels/slack/message-action-affordances.ts#L63), [observer digest:26](../../../../apps/core/src/channels/slack/observer-digest-affordances.ts#L26).
   Entity-safe truncation: [brain reviews:109](../../../../apps/core/src/channels/slack/brain-review-affordances.ts#L109), [observer digest:37](../../../../apps/core/src/channels/slack/observer-digest-affordances.ts#L37).

   **Survive:** one implementation of each primitive; keep the native card layouts. **Delete:** local copies. **Size:** medium, a story. **Risk:** preserve the question button’s empty-label fallback and whole entities/Unicode characters.

4. **Reaction cache bookkeeping is copied six times — duplicate**

   Adding or removing a reaction repeats reconciliation invalidation, abort listeners, successful cache updates and listener cleanup.

   **Locations:** Slack [add:35](../../../../apps/core/src/channels/slack/reactions.ts#L35)/[remove:73](../../../../apps/core/src/channels/slack/reactions.ts#L73); Discord [add:18](../../../../apps/core/src/channels/discord/ambient-liveness.ts#L18)/[remove:49](../../../../apps/core/src/channels/discord/ambient-liveness.ts#L49); Telegram [add:4](../../../../apps/core/src/channels/telegram/reactions.ts#L4)/[remove:54](../../../../apps/core/src/channels/telegram/reactions.ts#L54).

   **Survive:** native API calls and provider-specific success/error handling. **Merge:** only the cache-and-abort lifecycle into one small helper. **Size:** small, three consumers plus helper and check. **Risk:** Telegram invalidates every reaction on a message; Slack and Discord invalidate one. Preserve that difference and late-completion protection.

5. **Seven hand-written fetch timeout wrappers — duplicate / over-complicated**

   Setup, discovery and membership validation each manage an abort controller, timer and cleanup for the same job.

   **Locations:** [membership:453](../../../../apps/core/src/channels/conversation-membership-validation.ts#L453), [Teams discovery:78](../../../../apps/core/src/channels/teams/setup-discovery.ts#L78), [Discord discovery:91](../../../../apps/core/src/channels/discord/setup-discovery.ts#L91), [Slack CLI:77](../../../../apps/core/src/cli/slack.ts#L77), [Telegram CLI:130](../../../../apps/core/src/cli/telegram.ts#L130), [Slack chat discovery:30](../../../../apps/core/src/cli/slack-chat-discovery.ts#L30), [Telegram chat discovery:31](../../../../apps/core/src/cli/telegram-chat-discovery.ts#L31).

   **Survive:** call-site timeout values and error messages. **Delete:** timer wrappers; use `AbortSignal.timeout`, already used in [Slack canvas:531](../../../../apps/core/src/channels/slack/canvas.ts#L531). **Size:** medium, a story. **Risk:** native timeout errors differ, and the signal remains active during response-body consumption; verify those boundaries.

6. **Teams Graph authentication and pagination are implemented twice — duplicate**

   Discovery and membership validation independently acquire the same Graph token and follow `@odata.nextLink`.

   **Locations:** tokens in [Teams discovery:125](../../../../apps/core/src/channels/teams/setup-discovery.ts#L125) and [membership:376](../../../../apps/core/src/channels/conversation-membership-validation.ts#L376); pagination in [Teams discovery:153](../../../../apps/core/src/channels/teams/setup-discovery.ts#L153) and [membership:403](../../../../apps/core/src/channels/conversation-membership-validation.ts#L403).

   **Survive:** discovery’s token routine and page collector, which already serve several callers. **Merge/delete:** membership’s duplicate transport loops; retain its endpoint choice and member-ID extraction. **Size:** small. **Risk:** preserve credential trimming, timeouts and fail-closed membership results.

7. **Slack retains obsolete error shapes and an unused fallback helper — dead**

   Reaction predicates still recognize Bolt-style `data.error`, although their request path uses native `fetch` and produces `SlackLiveUxResponseError`. The brain-review fallback export has no reference elsewhere in `apps/core`.

   **Locations:** obsolete branches at [reactions:11](../../../../apps/core/src/channels/slack/reactions.ts#L11) and [reactions:24](../../../../apps/core/src/channels/slack/reactions.ts#L24); actual producer at [live-ux:71](../../../../apps/core/src/channels/slack/live-ux.ts#L71); unused [fallback:59](../../../../apps/core/src/channels/slack/brain-review-affordances.ts#L59).

   **Survive:** typed error checks and the wired card renderer. **Delete:** both SDK-shaped branches and the unused export. **Size:** small. **Risk:** none identified in the traced production callers.

Observed planned work, excluded from findings:

- Permission prompt maps in [Slack:129](../../../../apps/core/src/channels/slack/channel-state.ts#L129), [Telegram:58](../../../../apps/core/src/channels/telegram/channel-state.ts#L58), [Discord:73](../../../../apps/core/src/channels/discord/interactions.ts#L73), [Teams:118](../../../../apps/core/src/channels/teams/index.ts#L118) — covered by PERMFLOW-1..4 / MSG-3.
- Slack mutation and stream retry loops at [delivery:76](../../../../apps/core/src/channels/slack/channel-delivery-helpers.ts#L76), [stream:69](../../../../apps/core/src/channels/slack/native-stream.ts#L69) — covered by MSG-2.
- Slack’s native form opener at [rich-interaction:414](../../../../apps/core/src/channels/slack/rich-interaction.ts#L414) — covered by UX-1.
- Slack native stream start at [native-stream:19](../../../../apps/core/src/channels/slack/native-stream.ts#L19) — covered by PROV-1..4.
- Todo/progress Stop action construction at [agent-todo-render:87](../../../../apps/core/src/channels/agent-todo-render.ts#L87) — covered by the Stop-button deletion.

Ranked by user impact, then estimated deletion potential:

1. Discord Unicode splitting.
2. Misleading provider-account statuses.
3. Seven timeout wrappers.
4. Repeated Slack formatting primitives.
5. Duplicate Teams Graph transport.
6. Repeated reaction bookkeeping.
7. Dead Slack helpers.
