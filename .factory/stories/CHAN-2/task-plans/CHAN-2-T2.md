# CHAN-2-T2 — Split the Telegram callback by action kind

Contract: the `bot.on('callback_query:data')` callback in `apps/core/src/channels/telegram/channel-connect.ts` becomes a thin dispatcher; each action kind lives in a named function in ONE sibling module `apps/core/src/channels/telegram/callback-handlers.ts`. No behaviour change; existing telegram unit tests pass unchanged (additions only). Ceilings (owner choice): each handler cyclomatic complexity <= 25, the dispatcher <= 15 (AST count, baseline 1).

Steps:
1. Define `TelegramCallbackContext` (raw `data`, callback query id, message id, chat id/jid, thread id, user id, provider account id, an `answer(text?)` helper) and build it ONCE at the top of the callback.
2. Move each existing branch into `callback-handlers.ts` as a named function taking `(channel, ctx)` — user-question answers (`other`/`done`), `lt:stop`, `jp:` job-permission card taps, `r:` compact retry, `perm:` classic prompt — moving call sites, not re-implementing `parseJobPermissionCardAction`, `decideJobPermission`, or the existing `lt:stop` / `perm:` helpers.
3. The callback becomes: parse data → build context → dispatch by prefix (a small ordered table or if-chain) → existing default. If the `jp:` handler exceeds CC 25, split it into parse-token / resolve-target / apply-decision helpers inside the same module.
4. Add an architecture-map entry for the new module in `scripts/architecture-map.json` if `npm run check:architecture` requires one.
5. Verify: `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/channels/telegram.test.ts` and the channels folder unchanged and green; full unit lane; `npx tsc --noEmit`; `npm run check:architecture`; a CC report over `channel-connect.ts` and `callback-handlers.ts` (AST counter) showing dispatcher <= 15 and every handler <= 25.

Not in scope: any behaviour change, runActiveJob / runQuery (CHAN-3), Slack/Discord/Teams.
