---
reader: codex (gpt-6-sol)
read_at: 2026-09-29T06:23:37+00:00
read_hash: 9ad43bd60e68557a63034ecd933f333a52f0f369
amended_hash: a8b78f1a67dcff85b4aebac3027f51ac08e280f0
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc once, then
run `forge read <doc> --amended`:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options. There is no second read.

1. The story needs an explicit dependency on “One message, one turn.”
   That spec defines message identity and consumption but has not been implemented here. Pin which durable record is the steering inbox so this work does not create a second account of whether a follow-up was read.
   Disposition: keep amended: the spec now depends on TURN-1 explicitly; the consumption record and delivered ids are the only record of read state, and the inbox is an in-memory view

2. “Taken in” has no defined acknowledgement boundary.
   Today a continuation is marked applied when written to runner input, and the “seen” reaction is sent when it is queued; neither proves the model received it. Pin the transition for steered, final-reply fallback, and history-only-on-/stop messages, including how a crash or /stop races with delivery. AC1, AC4, AC5, and the metric depend on it.
   Disposition: keep amended: acknowledgement means received for the running turn (at routing time); model receipt comes from the delivered ids; /stop keeps undelivered messages as history, a crash sends them to the next turn, and a delivery at the same instant counts

3. The one-reply promise conflicts with output that may already be visible.
   [group-output-buffer.ts](/apps/core/src/runtime/group-output-buffer.ts:195) sends text chunks during a run. A correction can arrive after outdated text has streamed but before the next tool boundary. Define whether AC1 means one final message or one wholly corrected visible reply, and how that case is counted.
   Disposition: keep amended: one reply means no second turn or card; text already shown stays and the rest of the answer reflects the change; counted as steered when delivery is confirmed in the turn and no second turn starts

4. The final-text fallback lacks the follow-up’s reply target.
   The current continuation input contains text and a thread ID, but no follow-up message ID or provider reference. Pin those fields and their path through the runner and outbound delivery so AC2 can reply to the follow-up itself.
   Disposition: keep amended: the follow-up's message id and provider reference travel through the continuation input and the runner's follow-up marker to outbound delivery; the reply goes to the newest follow-up

5. AC5 does not cover every existing chat channel as written.
   Telegram, Discord, and Slack have “seen” reaction paths; the Teams channel has no corresponding reaction path. Specify Teams’ acknowledgement behavior and the web “received” event’s message ID, turn ID, and delivery point before requiring parity across channels.
   Disposition: keep amended: the reaction applies to Telegram, Discord and Slack; Teams has no reaction path and doesn't connect today; the web event carries the message id and turn id and is sent at routing time
