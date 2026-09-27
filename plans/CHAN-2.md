# Channel dispatchers: flatten repeated guards and split the Telegram callback by action kind

## What changes for you

In scope: (1) the five hoists named in the review; (2) splitting the Telegram callback into one named handler per action kind in ONE sibling module (`telegram/callback-handlers.ts` — owner choice 2026-08-27) plus a thin dispatcher, with the callback context (message, chat, thread, user, provider account) computed once and passed in. Non-goals: `runActiveJob` and `runQuery` (CHAN-3); any behaviour change; any change to what messages, cards or permissions do.

## Why

The Codex cyclomatic review of PR #444 measured the Telegram `bot.on('callback_query:data')` callback in `apps/core/src/channels/telegram/channel-connect.ts` (lines 59–~750) at CC 188 — one function handling user-question answers, `lt:stop`, `jp:` card taps, `r:` compact retries and `perm:` classic prompts, recomputing the callback context per branch. It also found five places where an optional-guard chain is recomputed per branch. Nothing here is behaviour; all of it makes provider-side review harder than it should be.

## Done when

1. AC1: The five review hoists are applied: telegram/message-action-affordances.ts dead early-returns removed; telegram/channel-connect.ts callback context computed once; slack/channel-message-action-handler.ts channelId/userId hoisted; discord/interactions.ts component user id hoisted; teams/cards.ts thread fragment computed once.
2. AC2: The Telegram bot.on callback in telegram/channel-connect.ts is split by action kind into named handlers, each with cyclomatic complexity <= 25, dispatched from a callback whose own complexity is <= 15; no behaviour change.
3. AC3: No behaviour change: existing unit tests pass unchanged (only new tests may be added); tsc, architecture check, unit + Postgres integration lanes green.
4. AC4: Lands after PR #446 merged (CHAN-1 folder layout); branch based on main after it.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | Five repeated-guard hoists across the provider adapters | Apply the five hoists from the PR #444 cyclomatic review, one per file, no signature or behaviour change: dead early-returns removed in telegram/message-action-affordances.ts; callback context computed once in telegram/channel-connect.ts; channelId/userId hoisted in slack/channel-message-action-handler.ts; component user id computed once in discord/interactions.ts; thread fragment computed once in teams/cards.ts. Existing unit tests pass unchanged. | 1, 4 | `apps/core/src/channels/telegram/`, `apps/core/src/channels/slack/`, `apps/core/src/channels/discord/`, `apps/core/src/channels/teams/`, `apps/core/test/unit/channels/`, `scripts/architecture-map.json` | `apps/core/test/unit/channels/telegram.test.ts` | none | no |
| T2 | Split the Telegram callback by action kind | Extract a TelegramCallbackContext built once at the top of the bot.on('callback_query:data') callback in telegram/channel-connect.ts and move each action-kind branch (user-question answers, lt:stop, jp:, r:, perm:) into a named function in one sibling module telegram/callback-handlers.ts; the callback becomes parse -> context -> dispatch by prefix -> existing default. Handler CC <= 25, dispatcher CC <= 15; existing telegram tests pass unchanged. | 2, 3 | `apps/core/src/channels/telegram/`, `apps/core/test/unit/channels/`, `scripts/architecture-map.json` | `apps/core/test/unit/channels/telegram.test.ts` | T1 | no |

New moving parts: none named in the old plan

## Risks

- Behaviour drift while moving branches into handlers: mitigated by "existing tests unchanged" as a hard rule plus per-handler CC measurement; any edit to an existing test other than additions is a red flag.
- Line budgets: the new module may need an architecture-map entry.

## Notes

Converted from plans/active/CHAN-2-channel-dispatchers-flatten-repeated-guards-and-split-the-telegram-callback-by-action-kind.md by forge migrate.

### Technical Approach

Two tasks:
1. **CHAN-2-T1 Hoists**: the five one-line/one-block simplifications, each in its own file, no signature changes. Verified by the unchanged unit suites of each provider.
2. **CHAN-2-T2 Telegram dispatcher split**: extract a `TelegramCallbackContext` built once at the top of the callback; move each action-kind branch into a named function in ONE sibling module (`telegram/callback-handlers.ts`); the callback becomes: parse data → build context → dispatch by prefix → existing default. Ceilings (owner choice 2026-08-27): handler <= 25, dispatcher <= 15, measured with an AST cyclomatic counter (the review's method); if the `jp:` handler exceeds 25, split it into parse-token / resolve-target / apply-decision helpers inside the same module. The split moves call sites; it does not re-implement `parseJobPermissionCardAction`, `decideJobPermission`, or the `lt:stop` / `perm:` helpers. Existing telegram tests pass unchanged.

### Decisions

No new decision record: internal structure only; no contract, interface or behaviour change. Active decisions reviewed; none constrains this.

### Surface Impact

Internal to the four provider adapters. No CLI/API/settings/schema/docs/user-visible change. A new module may need an entry in `scripts/architecture-map.json`.

### Task Decomposition

- CHAN-2-T1: five hoists (5 files; tests untouched).
- CHAN-2-T2: Telegram callback split (channel-connect.ts + telegram/callback-handlers.ts + architecture-map entry; tests unchanged or added).

### Verify Plan

- `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/channels` unchanged and green; full unit lane; `npm run test:integration:postgres`; `npx tsc --noEmit`; `npm run check:architecture`.
- CC report on `channel-connect.ts` and `callback-handlers.ts`: dispatcher <= 15, every handler <= 25.
