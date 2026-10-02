---
slug: provider-native-features
title: Each provider streams and paces replies the way it does best
status: confirmed
saved: 2026-10-02T06:48:46+00:00
confirmed_by: "Ravi"
confirmed_hash: 33c0e482c110fac43048f6ff9ff6f858351eb861b5e782a28848b909874b725c
---

# Each provider streams and paces replies the way it does best

## Why

People should see a reply forming as the agent writes it, and it should never stall because Gantry broke a provider's rules. A review of each provider's current API on 2026-10-02 ([notes](../context/provider-api-review-2026-10-02.md)) found that Gantry falls short on both.

**Telegram direct messages never stream.**
- In a direct chat, the person sees nothing until the whole reply is done, sometimes a minute or more.
- Since March 2026, Telegram lets every bot stream a reply in private chats as an animated draft.
- Gantry's earlier attempt never ran: one line limited streaming to group chats, and the unreachable code was later deleted (#544).

**Slack streams faster than Slack allows.**
- Gantry updates a streamed reply every 550 ms, about 109 times a minute.
- Slack allows about 50 a minute for message edits.
- It allows about 100 a minute for the whole workspace for native streaming, so two replies streaming at once already go over.
- Over the limit, Slack refuses calls and the reply stalls.

**Discord reconnects to the wrong address.** After a disconnect, Gantry resumes on the original gateway address instead of the resume address Discord gives it. Discord says this causes more disconnects.

**Permission prompts look plain.** Telegram can now colour buttons (green, red) and grey them out once answered. Gantry's three-button prompt uses neither, so an answered prompt still looks tappable.

**Slack's assistant status is going away.** Gantry uses Slack's assistant view and its status call. Slack is replacing them with agent sessions; the assistant view is deprecated in February 2027.

## Behaviour

**Replies stream wherever the provider can stream them.**

- **Telegram direct messages** stream as an animated draft.
  - **Refresh.** The draft is refreshed at least every 20 seconds, so it never expires during a long tool run.
  - **Finish.** The finished reply is sent as normal messages, split at Telegram's 4,096-character limit by the existing splitter, and the draft goes away. While the reply is longer than the limit, the draft shows its newest part.
  - **Progress lives in the draft.** In a direct chat, progress shows inside the draft, not as a separate message, because Telegram clears a draft whenever the bot sends a message.
  - **A permission prompt interrupts the draft.** The prompt is a message, so the draft clears. When the turn continues, a new draft starts.
  - **When Telegram says "slow down" for longer than a draft lasts,** the draft may disappear. Once Telegram allows updates again, it comes back showing the newest part of the text, within the 4,096-character limit. The final reply still carries the complete text.
  - **A draft is not a reply.** The turn takes its input as One message, one turn defines, so no other worker can take it while the draft shows. Showing a draft never marks the reply as sent; only the first normal reply message does.
  - **A crash mid-reply.** If the host stops while a draft shows but before any normal message is sent, the draft disappears. The failed turn had not replied, so recovery releases its input under One message, one turn's failure rule, and the retried turn sends exactly one final reply.
  - **Groups.** Telegram groups keep streaming by editing a message, as today.
- **Slack** streams natively wherever Slack allows it.
  - **Native:** thread replies and assistant threads.
  - **Edits:** a top-level reply keeps streaming by editing a message, because Slack refuses native streams outside threads. That covers an ordinary channel and a direct message sent outside a thread; such replies stay top-level, as today.
  - **Progress.** While the agent works, progress shows as Slack's native task steps inside the reply, instead of a separate status message.
  - **One home for progress.** Progress lives in one place per provider. Where the native steps are shown, no other progress line is sent.
- **Discord** keeps streaming by editing a message, because Discord has no streaming API.

**Gantry stays within each provider's limits.**

- **Pace.** Each provider's update pace is set from its documented limits, not guessed:
  - **Slack edits:** about 1.2 seconds apart.
  - **Slack native streaming:** about 1 second apart.
  - **Shared budgets.** Slack counts each method's limit per app and per workspace, so every reply and progress update that uses one method in a workspace shares one budget. Several replies streaming at once each get a fair share, so their updates slow down rather than going over.
- **Waiting when refused.** When a provider says "slow down", Gantry waits exactly as long as the provider asks. Every reply that shares that budget waits too. The replies then continue where they were, never dropping text or starting a second message.
- **Discord resume.** Discord resumes on the address Discord gives at connect time.

**One way to stop.**

- **/stop is the only way to stop a reply,** on every provider. Gantry shows no Stop button, its own or a provider's native one.
  - Owner choice, 2026-10-02: "we can just use /stop".
  - The existing progress-card Stop button is deleted by a separate fix.
- **Native Stop buttons stay off.** Telegram's draft Stop button (`can_stop`) and Slack's agent-session Stop are not enabled.

**Permission prompts use the provider's own button styles.**

- **Telegram buttons.**
  - Allow once and Allow for future are green, and Deny is red.
  - Once a prompt is answered, its buttons are greyed out and the answer is shown.
- **Other providers.** They use their equivalent styles where they have them, and plain buttons otherwise. The three buttons and their meaning don't change.

**Slack moves to agent sessions.** Gantry's progress status on Slack uses agent sessions, and Gantry stops using the assistant view before Slack's February 2027 deprecation.
- **What it needs.** Slack only gives sessions to an app declared as an agent, with the scopes Slack's agent-session docs name. `gantry doctor` lists exactly what is missing.
- **What it must not have.** Gantry never subscribes to `agent_session_stopped`, because that subscription makes Slack show a Stop button. Neither setup nor `gantry doctor` recommends it.
- **Without it.** Progress still shows as native task steps inside the streamed reply, and only the session status line is missing.

**Out of scope**
- **Telegram rich messages** (formatted streaming drafts with tables): a later spec.
- **Discord's message nonce,** which prevents duplicate sends: part of One messaging pipeline (MSG-2).
- **Teams and WhatsApp streaming:** built with those providers (TEAMS-1, WA-1), on this same behaviour.

## Risks

- **Slack agent sessions need app setting changes.** Existing Slack installs need the app declared as an agent, plus new scopes or event subscriptions. `gantry doctor` names what's missing, and Gantry keeps working without them, minus the session status line.
- **A Telegram draft is temporary.** If the bot crashes mid-reply, the draft disappears and the turn's recovery sends one final reply instead.
- **Slower Slack updates.** A streamed Slack reply updates about half as often as today. That is the provider's limit, and it is the price of no longer stalling.
- No data is deleted and nothing is migrated.

## Acceptance criteria

- **AC1. Telegram direct-chat streaming.**
  - A reply shows as a growing draft within 2 seconds of the agent's first text.
  - Progress shows inside the draft.
  - The draft stays visible through a 90-second tool run.
  - It ends as the normal reply messages, split as today when the reply is longer than 4,096 characters.
  - A permission prompt in the middle clears the draft, and a new draft follows.
  - While a draft shows, a second worker can't take the turn's input.
  - A host restart after a draft was shown, but before any normal message, ends with exactly one final reply.
  - A long "slow down" on a reply longer than 4,096 characters brings the draft back showing its newest part, and the final reply carries the complete text.
- **AC2. No Stop button anywhere.** No provider shows a Stop button on a reply or a progress card, and /stop stops a running turn on every provider.
- **AC3. Slack pacing.** Two Slack replies streaming at once in one workspace stay under Slack's documented limits, for native appends and for fallback edits alike. A "slow down" response pauses every reply sharing that budget for the time Slack asks, without losing or duplicating text.
- **AC4. Discord resume.** After a Discord disconnect, Gantry resumes on Discord's resume address and the session continues.
- **AC5. Telegram button styles.** Permission prompt buttons are coloured, and an answered prompt's buttons are greyed out and show the answer.
- **AC6. Slack native streaming and status.**
  - Thread replies and assistant threads stream natively, and show progress as native task steps.
  - A top-level reply, in a channel or to a direct message sent outside a thread, stays top-level and streams by edits.
  - Agent-session status works when the app is configured as an agent, and `gantry doctor` names what is missing when it isn't.
  - No Stop button appears, because `agent_session_stopped` isn't subscribed.
  - No assistant-view status call is made.

## Success measure

- Metric: provider rate-limit refusals (HTTP 429 or `retry_after`) from Slack, Telegram and Discord per week, counted from the runtime logs.
- Baseline: the count over the full week before PROV-1 starts.
- Target: zero in the first full month after the last story merges.
- Check date: 2027-03-01

## Roadmap

- PROV-1: Slack and Discord stay within their limits and reconnect cleanly
- PROV-2: Telegram direct messages stream the reply as it is written
- PROV-3: Permission prompts use each provider's own button styles
- PROV-4: Slack replies use agent sessions and native progress steps
