---
slug: channel-dispatchers-flatten-and-split
title: Channel dispatchers: flatten repeated guards and split the Telegram callback by action kind
status: draft
saved: 2026-08-27T12:58:07+00:00
---

# Channel dispatchers: flatten repeated guards and split the Telegram callback by action kind

## Why

A cyclomatic-complexity review of PR #444 (Codex, 2026-08-27) measured the Telegram message-action callback in `apps/core/src/channels/telegram/channel-connect.ts` at 188 (the largest function in the changed set) and found five places where the same optional-guard chain is recomputed per branch. None of it is behaviour; all of it makes provider-side changes harder to review than they should be. The owner chose to retire the Telegram hotspot and apply the five hoists now, and to leave the run-loop giants (`runActiveJob`, `runQuery`) for a later story.

## Behaviour

Nothing a user or another module can observe changes. The Telegram `bot.on` callback becomes a thin dispatcher that recognises the action kind (`lt:stop`, `jp:` job-permission card taps, and the other existing kinds) and calls one named handler per kind; each handler receives the callback context (message, chat, thread, user, provider account) computed once. The five hoists remove repeated guard chains in the Telegram affordance parser, the Slack action handler, the Discord component interaction handler and the Teams card builder. Existing unit tests pass unchanged.

## Acceptance criteria

- The five review hoists are applied: telegram/message-action-affordances.ts dead early-returns removed; telegram/channel-connect.ts callback context computed once; slack/channel-message-action-handler.ts channelId/userId hoisted; discord/interactions.ts component user id hoisted; teams/cards.ts thread fragment computed once.
- The Telegram bot.on callback in telegram/channel-connect.ts is split by action kind into named handlers, each with cyclomatic complexity <= 25, dispatched from a callback whose own complexity is <= 15; no behaviour change.
- No behaviour change: existing unit tests pass unchanged (only new tests may be added); tsc, architecture check, unit + Postgres integration lanes green.
- Lands after PR #446 merged (CHAN-1 folder layout); branch based on main after it.
