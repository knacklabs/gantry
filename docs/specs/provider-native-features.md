---
slug: provider-native-features
title: Each provider streams, paces and stops replies the way it does best
status: draft
saved: 2026-10-02T06:48:46+00:00
---

# Each provider streams, paces and stops replies the way it does best

## Why

People should see a reply forming as the agent writes it, be able to stop it, and never have it stall because Gantry broke a provider's rules. A review of each provider's current API on 2026-10-02 ([notes](../context/provider-api-review-2026-10-02.md)) found that Gantry falls short on all three.

**Telegram direct messages never stream.**
- In a direct chat, the person sees nothing until the whole reply is done, sometimes a minute or more.
- Since March 2026, Telegram lets every bot stream a reply in private chats as an animated draft. Since August 2026, that draft has a native Stop button.
- Gantry's earlier attempt never ran: one line limited streaming to group chats, and the unreachable code was later deleted (#544).

**Slack streams faster than Slack allows.**
- Gantry updates a streamed reply every 550 ms, about 109 times a minute.
- Slack allows about 50 a minute for message edits.
- It allows about 100 a minute for the whole workspace for native streaming, so two replies streaming at once already go over.
- Over the limit, Slack refuses calls and the reply stalls.

**Discord reconnects to the wrong address.** After a disconnect, Gantry resumes on the original gateway address instead of the resume address Discord gives it. Discord says this causes more disconnects.

**Stopping a reply needs a typed /stop.** Telegram (August 2026) and Slack (agent sessions, August 2026) now offer a native Stop button on a reply that is being written. Gantry uses neither.

**Permission prompts look plain.** Telegram can now colour buttons (green, red) and grey them out once answered. Gantry's three-button prompt uses neither, so an answered prompt still looks tappable.

**Slack's assistant status is going away.** Gantry uses Slack's assistant view and its status call. Slack is replacing them with agent sessions; the assistant view is deprecated in February 2027.

## Behaviour

**Replies stream wherever the provider can stream them.**

- **Telegram direct messages** stream as an animated draft.
  - **Refresh.** The draft is refreshed at least every 20 seconds, so it never expires during a long tool run.
  - **Finish.** The finished reply is sent as a normal message, and the draft goes away.
  - **Groups.** Telegram groups keep streaming by editing a message, as today.
- **Slack** streams top-level replies as well as thread replies, using Slack's native streaming.
  - **Progress.** While the agent works, progress shows as Slack's native task steps inside the reply, instead of a separate status message.
  - **One home for progress.** Progress lives in one place per provider. Where the native steps are shown, no other progress line is sent.
- **Discord** keeps streaming by editing a message, because Discord has no streaming API.

**Gantry stays within each provider's limits.**

- **Pace.** Each provider's update pace is set from its documented limits, not guessed:
  - **Slack edits:** about 1.2 seconds apart.
  - **Slack native streaming:** about 1 second apart, slowing down when several replies stream in one workspace at once.
- **Waiting when refused.** When a provider says "slow down", Gantry waits exactly as long as the provider asks, then continues the same reply. It never drops text or starts a second message.
- **Discord resume.** Discord resumes on the address Discord gives at connect time.

**Stop from the reply itself.**

- **Where.** A reply that is being written shows the provider's native Stop button where one exists: Telegram direct-message drafts and Slack agent sessions.
- **What it does.** Tapping it does exactly what /stop does: the turn stops, and what was already written stays.
- **Elsewhere.** Where there is no native Stop, /stop works as today.

**Permission prompts use the provider's own button styles.**

- **Telegram buttons.**
  - Allow once and Allow for future are green, and Deny is red.
  - Once a prompt is answered, its buttons are greyed out and the answer is shown.
- **Other providers.** They use their equivalent styles where they have them, and plain buttons otherwise. The three buttons and their meaning don't change.

**Slack moves to agent sessions.** Gantry's status and Stop on Slack use agent sessions. Gantry stops using the assistant status call and the assistant view before Slack's February 2027 deprecation.

**Out of scope**
- **Telegram rich messages** (formatted streaming drafts with tables): a later spec.
- **Discord's message nonce,** which prevents duplicate sends: part of One messaging pipeline (MSG-2).
- **Teams and WhatsApp streaming:** built with those providers (TEAMS-1, WA-1), on this same behaviour.

## Risks

- **Slack agent sessions need app setting changes.** Existing Slack installs may need a new scope or event subscription. Setup must tell the admin plainly what to change, and Gantry must keep working without it, just without the native Stop.
- **Telegram drafts are only visible to the person in the chat.** If the bot crashes mid-reply, the draft disappears after 30 seconds and no message is left. The reply is still delivered once the turn finishes, through the outbox.
- **Slower Slack updates.** A streamed Slack reply updates about half as often as today. That is the provider's limit, and it is the price of no longer stalling.
- No data is deleted and nothing is migrated.

## Acceptance criteria

- **AC1.** In a Telegram direct chat, a reply shows as a growing draft within 2 seconds of the agent's first text. It is refreshed through a 90-second tool run, and it ends as one normal message.
- **AC2.** Tapping the native Stop button on a Telegram draft or a Slack agent session stops the turn, exactly as /stop does, and keeps what was written.
- **AC3.** Two Slack replies streaming at once in one workspace stay under Slack's documented limits, and a "slow down" response is waited out without losing or duplicating text.
- **AC4.** After a Discord disconnect, Gantry resumes on Discord's resume address and the session continues.
- **AC5.** On Telegram, permission prompt buttons are coloured, and an answered prompt's buttons are greyed out showing the answer.
- **AC6.** On Slack, top-level replies stream natively and show progress as native task steps. No assistant-view status call is made.

## Success measure

- Metric: provider rate-limit refusals (HTTP 429 or `retry_after`) from Slack, Telegram and Discord per week, counted from the runtime logs.
- Baseline: the count over the full week before PROV-1 starts.
- Target: zero in the first full month after the last story merges.
- Check date: 2027-03-01

## Roadmap

- PROV-1: Slack and Discord stay within their limits and reconnect cleanly
- PROV-2: Telegram direct messages stream the reply with a native Stop button
- PROV-3: Permission prompts use each provider's own button styles
- PROV-4: Slack replies use agent sessions, top-level streaming and native progress
