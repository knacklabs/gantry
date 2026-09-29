---
slug: one-message-one-turn
title: One message, one turn
status: draft
saved: 2026-09-29T03:41:13+00:00
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

- **A split message or quick burst gets one reply.** Messages from one conversation that arrive close together are answered in one turn. Gantry waits a short quiet window after a message before starting a turn:
  - 1.5 seconds normally;
  - about 4 seconds when the last message is close to that platform's length limit, because it was probably split.

  Owner choice, 2026-09-29: "1.5s, longer near limit". Why: it catches platform splits without slowing every reply much. Session commands such as /stop are not delayed.
- **No message is skipped or given twice.** Each message is consumed exactly once, in the order Gantry received it, and the turn that took it in is recorded. A message saved late (a slow photo download, for example) stays waiting and is given to the agent in the current turn if one is running, or in the next turn. It is never stepped over. This holds with several workers and across settings reloads and restarts.
- **One rule decides whether a message starts or joins a turn, on every channel.** In a group that needs a mention, a message is for the agent when any of these holds:
  - it mentions the bot;
  - it arrives while the agent's turn in that conversation is running;
  - it is in the same quiet-window batch as a message that mentions the bot;
  - it replies to the bot's message, or is in a thread or topic where the bot already replied.

  Other group messages are kept as history only. Owner choice, 2026-09-29: "Yes, in the bot's thread". Why: it's the same natural rule on every provider. The sender allowlist (decision 0090) still applies.
- **Channels tell the host when the bot is mentioned.** Each channel adapter sets one "mentions the bot" flag from the platform's own mention format. Discord is first, so a real @mention works there.
- **An overloaded backlog is not silent.** When the backlog is full, a new message is still saved and seen as context in the next turn, and the sender gets a short notice that the agent is busy and they should resend. Owner choice, 2026-09-29: "Keep as history + tell sender". This amends decision 0049.

## Acceptance criteria

- AC1: Two or three messages from one conversation, arriving within the quiet window, start exactly one turn whose input holds all of them in received order. This holds on every channel, including a Telegram message split by the platform.
- AC2: No message is lost or given twice. A message saved after a turn started is given to the agent in that turn or the next one. It stays true with two worker processes and across a settings reload or restart.
- AC3: In a mention-required group, the following reach the agent without a new mention:
  - the parts of a split mention message;
  - a reply to the bot's message;
  - a follow-up in a thread or topic where the bot already replied;
  - a message sent while the agent's turn is running.

  An unrelated plain group message still does not start a turn.
- AC4: A real Discord @mention of the bot starts a turn.
- AC5: With a full backlog, the sender gets one short "busy, please resend" notice, and the message appears as context in the next turn.
- AC6: The old "read up to here" marker and the startup scan are gone. One record of what each message was consumed by replaces them.

## Success measure

- Metric: turns that started less than 5 seconds after an earlier turn in the same conversation, for the same sender, counted from the runtime's turn records. Also, messages still unconsumed 10 minutes after they arrived.
- Baseline: split turns happen on most long Telegram messages today, and messages are dropped with no record, so there is no count. Measure both numbers from the first week of runtime records before this ships.
- Target: no split turns for messages inside the quiet window, and zero messages left unconsumed after 10 minutes.
- Check date: 2026-11-15

## Roadmap

- TURN-1: One message, one turn
