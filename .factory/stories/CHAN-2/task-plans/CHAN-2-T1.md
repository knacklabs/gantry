# CHAN-2-T1 — Five repeated-guard hoists

Contract: behaviour-preserving simplifications from the PR #444 cyclomatic review; one block per file; no signature change; existing unit tests pass unchanged.

Steps:
1. `apps/core/src/channels/telegram/message-action-affordances.ts` (~line 64): delete the four unsupported-kind early returns — the empty-code lookup already rejects those kinds. Expected CC 7.
2. `apps/core/src/channels/telegram/channel-connect.ts` (~line 253): compute the callback context (message id, chat id, thread id, user id, provider account id) once for the adjacent `lt:stop` and `jp:` branches instead of re-deriving it in each.
3. `apps/core/src/channels/slack/channel-message-action-handler.ts` (~line 53): hoist `channelId`/`userId` once instead of five repeated optional-guard pairs.
4. `apps/core/src/channels/discord/interactions.ts` (~line 285): compute the component-interaction user id once and reuse it across the three action branches.
5. `apps/core/src/channels/teams/cards.ts` (~line 305): compute the optional thread fragment once before `.map()` and reuse it.
6. Verify: `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/channels` (unchanged tests, green); `npx tsc --noEmit`; `npm run check:architecture`.

Not in scope: the Telegram callback split (T2), any logic change, any test edit.
