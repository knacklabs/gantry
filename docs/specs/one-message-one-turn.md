---
slug: one-message-one-turn
title: One message, one turn
status: confirmed
saved: 2026-09-29T03:41:13+00:00
confirmed_by: "Ravi"
confirmed_hash: 4532596dbd96d0ebc3c207a00c1c6ab4bb99d411c932df0448080b6e81d3be66
---

# One message, one turn

## Why

People write to the agent the way they write to a person, and Gantry breaks that apart.

- A long Telegram message arrives as two parts, and the agent answers each part separately, one after the other. It gets worse on Discord, where a 2,000-character limit makes people split long text themselves, and when two or three short messages are sent quickly.
- In a group where the bot must be mentioned, the second half of a split "@bot …" message and any "also …" follow-up are dropped without a trace. Discord never counts a real @mention at all.
- A photo sent just before its question can be skipped for good. The agent answers "what's this?" without the photo.
- With two workers, or after a settings reload, the agent can be given the same message twice.

All of these come from one design flaw. "Which messages has the agent already taken in?" is stored three times with different lifecycles:

- a per-message work item that is marked done before any turn runs;
- an in-memory "read up to here" marker saved as one blob, where the last writer wins;
- a startup scan that tries to catch what the other two missed.

Order also comes from the platform's clock in whole seconds, so a message that is saved late or sorted wrongly is stepped over.

More channels are coming (WhatsApp, a web SDK). Fixing this inside each channel adapter would repeat the bugs in every new one, so the fix belongs in the shared intake layer that every channel already goes through.

## Behaviour

- **Place in line is set by Gantry, not the platform.** Every message gets a receive number from the database when it is saved. The number is issued by one database sequence, so it is the same across all workers. A message saved late, such as a photo whose download finished after the next text, gets a later number than that text. The receive number decides which turn takes a message; it is never reordered for that.
- **A split message or quick burst gets one reply.** A batch is every waiting message in one conversation (and thread or topic, where the platform has them), from any sender, taken in receive order, up to 10 messages.
  - The agent sees the batch in the order the messages were sent: by the platform's time to the second, then by receive number. So a photo sent before its question comes first even if its download finished later. A session command or control message that ended the batch always stays last.
  - Owner choice, 2026-09-29: "present by platform time". Why: a slow upload shouldn't put an answer before its question. Ordering within the same second, by each platform's own message ordering key, comes with the channel intake story.
  - A turn starts 1.5 seconds after the newest message in the batch. Each new message restarts that wait, but a turn never waits more than 6 seconds after the first message of the batch.
  - When the newest message is a text at 90% or more of that platform's inbound length limit (Telegram 4,096 characters, Discord 2,000), the wait is 4 seconds, because it was probably split. Platforms with no known limit always use 1.5 seconds.
  - Owner choice, 2026-09-29: "1.5s, longer near limit". Why: it catches platform splits without slowing every reply much.
- **Session commands never wait.** /stop and other session commands are applied at once and don't restart the wait. /stop also cancels a batch that is still waiting; its messages are kept as history and do not start a turn.
- **Running-turn cutoff.** A message that arrives while the agent's turn in that conversation is running, before that turn's final reply is sent, joins that turn as a follow-up. A message arriving after the final reply starts the next batch.
- **Each message is consumed exactly once, and every message ends up consumed.** A message is consumed when a turn or command takes it, in the same database step that records which turn or command took it. A history-only group message is consumed as history, with no turn. Crash rule:
  - If a turn fails before any reply was sent to the user, its messages are released and taken again by the next turn.
  - Once any reply was sent, they stay consumed and are never given again.
  - A message saved late is still waiting, so it is given to the running turn or the next one. It is never stepped over. This holds with several workers, and across settings reloads and restarts.
- **One rule decides whether a batch starts or joins a turn, on every channel.** In a group that needs a mention, a batch is for the agent when any message in it:
  - mentions the bot;
  - arrives during the agent's running turn in that conversation;
  - replies to the bot's message, or is in a thread or topic where the bot already replied.

  Otherwise the batch is consumed as history only. Owner choice, 2026-09-29: "Yes, in the bot's thread". Why: it's the same natural rule on every provider. The sender allowlist (decision 0090) still applies.
- **Channels tell the host when the bot is mentioned.** Each channel adapter sets one "mentions the bot" flag from the platform's own mention format. Discord is first in this story, so a real @mention works there. Other channels keep today's text-pattern match until they set the flag.
- **A full backlog is not silent.** When the backlog cap is reached (decision 0049), a new message is still saved, but only as conversation history. It is never new input, so a resend is not doubled; if no later turn happens, it simply stays in history. The sender gets a short "busy, please resend" notice, at most once per conversation every 5 minutes. Owner choice, 2026-09-29: "Keep as history + tell sender". This amends decision 0049.

## Acceptance criteria

- AC1: On every channel, including a Telegram message split by the platform, messages from one conversation that arrive within the wait rule above start exactly one turn, with all of them in receive order. Tests cover:
  - the 1.5-second restart;
  - the 6-second cap;
  - the 4-second near-limit wait;
  - a platform with no limit;
  - /stop during a waiting batch.
- AC2: Every message is consumed exactly once. The tests are:
  - a message saved after a turn started reaches the agent in that turn or the next;
  - with two worker processes, and across a settings reload and a restart, no message is given twice or left unconsumed;
  - a turn that fails before replying releases its messages, and one that fails after replying does not.
- AC3: In a mention-required group, these reach the agent without a new mention:
  - the parts of a split mention message;
  - a reply to the bot's message;
  - a follow-up in a thread or topic where the bot already replied;
  - a message sent while the agent's turn is running.

  An unrelated plain group message is kept as history and starts no turn.
- AC4: A real Discord @mention of the bot starts a turn.
- AC5: With a full backlog, the sender gets one "busy, please resend" notice at most every 5 minutes per conversation, and the message appears only as history.
- AC6: The old "read up to here" marker and the startup scan are gone. One record of what each message was consumed by replaces them.

## Success measure

- Metric: split turns, meaning turns that started less than 5 seconds after an earlier turn in the same conversation, counted from the live-turn records. Also, messages still unconsumed 10 minutes after they were saved.
- Baseline: split turns are counted from the live-turn records for the two weeks before release. The unconsumed count can't be measured before release, because the consumed record is new. It starts at release with no earlier baseline, and today the dropped messages it would catch leave no record.
- Target: no split turns for messages inside the wait rule, and zero messages left unconsumed after 10 minutes.
- Check date: 2026-11-15

## Roadmap

- TURN-1: One message, one turn
