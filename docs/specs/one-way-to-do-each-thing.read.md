---
reader: codex (gpt-6.1-sol)
read_at: 2026-10-02T09:41:05+00:00
read_hash: cf9356f03695b969dfac9e9ade2adc716e75dd7c
round: 3
passed: yes
doc_seen: cf9356f03695b969dfac9e9ade2adc716e75dd7c
spec_seen: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
notes_seen: 85350171f8be93667bc65b64e898764d6a90bfbf
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc, then run
`forge read <doc>` again for the next round, until a round finds nothing:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options.

## Round 1

1. AC6 and AC7 contradict the single Discord command spelling.
   Behaviour chooses typed `/stop`, `/new`, etc. for Discord, but AC7 retains Discord’s registered `/gantry` command. Decide whether registration is removed or another spelling remains, then align both criteria.
   Disposition: keep amended: Discord's registered /gantry command is removed and /stop is typed, which also removes the receipt; AC6 and AC7 aligned

2. Cut or defer: `/settings` introduces an undefined command.
   The current [session parser](/apps/core/src/session/session-command-parse.ts:7) has no settings command. This is more than removing aliases: define its behavior and authorization, or remove it from this spec.
   Disposition: keep amended: /settings removed; the spec covers only the commands help lists today and adds none

3. AC1 does not define how questions replace free-text form inputs.
   [ask_user_question](/apps/core/src/runner/mcp/tools/messaging.ts:462) requires two to four options. Discord’s [question controls](/apps/core/src/channels/discord/components.ts:145) have no free-text action. Pin how inputs such as a name or address reach the waiting agent on every promised provider.
   Disposition: keep amended: choices use questions; free text is asked in the message and answered by the next message, as in any conversation; AC1 covers both

4. AC5’s numbers-only buttons conflict with “Other” and multi-select completion.
   Telegram needs “Other,” and multi-select questions use “Done.” Specify that only option buttons become numbers, while completion, free-text entry and selected-state indicators remain usable.
   Disposition: keep amended: only option buttons become numbers; Other, Done and selected marks stay; AC5 covers them

5. AC2 leaves the combined card’s lifecycle undefined.
   [Todo rendering](/apps/core/src/app/bootstrap/channel-wiring-interactions.ts:317) currently retains conversation-level state, while ambient progress uses turn generations; `render_progress` creates another card kind. Pin behavior before a plan exists, after completion or restart, and when delayed updates or ambiguous edit failures occur, so merging these paths cannot overwrite another turn or create duplicates.
   Disposition: keep amended: the card is keyed by the turn with today's ambient-progress rules (older-turn updates ignored, final state kept, retries edit rather than post); AC2 adds the late-update case

6. The success measure cannot currently count the messages this spec removes.
   [Todo cards](/apps/core/src/channels/telegram/agent-todo-delivery.ts:6) and [ambient progress](/apps/core/src/channels/telegram/channel-delivery.ts:241) send directly through provider APIs, bypassing outbound message projection. Define an existing observable metric or the required measurement work, including request attribution, answer exclusion and counting new messages versus edits, before promising a database baseline.
   Disposition: keep amended: the metric is extra messages per request in the end-to-end suite's fake channel, which records every new message; the baseline is taken on main when UX-1 starts

## Round 2

7. The zero-extra-message target rejects updates the Behaviour explicitly permits.
   The metric counts every message except the answer, one card and questions, but agents may still send updates carrying real news. A valid news update therefore fails the target. Exclude those updates or explicitly restrict the measured scenarios to requests needing none.
   Disposition: keep amended: measured scenarios are requests whose fake agent sends no news updates

8. The retired-command help contradicts Slack’s supported spellings.
   Risks says `!stop` gets help showing `/stop`, while AC6 requires provider-specific help and Slack cannot use that spelling. Specify `/gantry stop` at channel level and `@Gantry stop` inside a Slack thread.
   Disposition: keep amended: the help shown for !stop names each provider's spelling, Slack's channel and thread forms included

## Round 3

No findings.
