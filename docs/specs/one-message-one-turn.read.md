---
reader: codex (gpt-6-sol)
read_at: 2026-09-29T03:43:01+00:00
read_hash: 254c2a22398b04aaee133d48dccca9c29a78524c
amended_hash: d406d9373faa79f0f56a6016d7bb8854232d94cb
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc once, then
run `forge read <doc> --amended`:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options. There is no second read.

1. Define “received order” for messages saved late.
   A photo may enter storage after a later text message. The current cursor uses provider timestamp and message ID in [message-cursor.ts](/apps/core/src/shared/message-cursor.ts:87). The spec needs to say when receipt order is assigned, including across workers, so AC1 and AC2 can be tested.
   Disposition: keep amended: a database-issued receive number assigned when the message is saved sets the order across workers; late saves get later numbers

2. Define when a message is consumed and how recovery treats it.
   “Given to the agent exactly once” and “the turn that took it in is recorded” leave the crash boundary open: a worker can fail after assigning a turn but before the runner receives its input. History-only group messages also have no consuming turn, which conflicts with the target of zero messages unconsumed after 10 minutes.
   Disposition: keep amended: consumed in the same step that records the taker; released on failure before any reply, kept after; history-only messages are consumed as history

3. Pin batch membership and the running-turn cutoff.
   AC1 groups by conversation, while the success metric groups by sender. The spec does not say whether another sender’s message joins the batch, or when a message arriving during a running turn becomes part of that turn rather than the next. Those choices affect both the promised single reply and mention-required groups.
   Disposition: keep amended: a batch is the whole conversation or thread from any sender; a message joins a running turn until its final reply is sent; the metric now counts by conversation

4. Make the quiet-window rule testable.
   “Close to” a platform limit and “about 4 seconds” do not define the threshold or timer reset rule. The spec also needs a rule for channels without a known length limit and for commands such as `/stop` arriving during a pending batch.
   Disposition: keep amended: the wait restarts per message, is capped at 6 s, and is 4 s at 90% of a known limit; no limit means 1.5 s; /stop never waits and cancels a waiting batch

5. Resolve the full-backlog outcome.
   AC5 says to retain the message as context in the next turn and tell the sender to resend. A resend can then put the same content in that turn twice; if no later turn starts, there is no defined path for the retained message to appear. Specify the notice’s frequency and the retained message’s disposition.
   Disposition: keep amended: an over-cap message is history only (never input, so a resend is not doubled); the notice goes out at most once per conversation every 5 minutes

6. Fix the proposed baseline.
   The success measure says dropped messages have no count, then calls for both numbers from the week before shipping. State what existing records can measure before release, and start the new unconsumed-message measure when its records exist.
   Disposition: keep amended: split turns get a baseline from two weeks of live-turn records; the unconsumed count starts at release
