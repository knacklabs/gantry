---
slug: steer-running-answer
title: Messages sent while the agent works steer its answer
status: draft
saved: 2026-09-29T06:18:16+00:00
---

# Messages sent while the agent works steer its answer

## Why

People correct the agent the way they'd correct a colleague: "wait, use the other file", "also check staging". Today, a message sent while the agent is working is held back until the agent has finished its whole answer. It is then treated as a new question. So:

- The agent finishes the wrong direction, sends that answer, and only then reads the correction. The user gets two replies: one outdated, one corrected.
- Each follow-up starts a new "working" card while the first answer is still streaming.
- Both agent engines (the Claude Agent SDK runner and the DeepAgents runner) do this, with slightly different code. That drift has already caused bugs.

The one-message-one-turn spec ([one-message-one-turn](one-message-one-turn.md)) makes sure these messages are never lost, but they still arrive too late to change the answer.

Both engines have a safe point to take in new input mid-work. It is after a batch of tool calls has finished and before the model's next step: the Claude SDK's `PostToolBatch` hook, and LangChain's `beforeModel` middleware. So a message can steer the work in progress without breaking the tool-call pairing either engine relies on.

The behaviour must be the same on both engines and on every channel, including future ones (WhatsApp, a web SDK).

## Behaviour

- **A message sent while the agent is working steers the current answer.** It is given to the agent at the next step boundary, after the tool calls running at that moment have finished and before the agent's next step. It comes with one shared framing, the same on both engines: new messages arrived while you were working; they may correct or change the current task; apply them now and briefly mention the change. The user gets one reply that reflects it, with one progress card. No second "working" card or reply is started.
- **Fallback when there is no step left.** If the agent is already writing its final text, with no more tool calls, the message is answered in a second reply straight after. On channels that support replies (Telegram, Discord, Slack threads), that second reply is threaded as a reply to the follow-up message. Owner choice, 2026-09-29: "Yes, reply to it". Nothing is lost, and the message is never answered before it arrives.
- **Only the main agent takes steering.** Subagents inside a turn don't. Scheduled and background runs never take mid-turn messages, as today.
- **/stop still stops at once.** A mid-work message the agent hasn't read yet when /stop is pressed is kept as conversation history and does not start a new turn. Owner choice, 2026-09-29: "Keep as history".
- **Acknowledgement on every channel.** Chat channels keep the "seen" reaction when a mid-work message is taken in. The web app and web SDK get one "received" event for the same moment. Owner choice, 2026-09-29: "Yes, add an event".
- **Engine-neutral by construction.** The inbox, the framing text, the delivered and undelivered rules, and the conformance tests live in shared runtime code. Each engine has only a thin adapter: the Claude `PostToolBatch` hook, and the DeepAgents `beforeModel` middleware. The old Claude-only steering gate is deleted.
- **Out of scope for now:** folding a message that arrives at the very last moment into the final answer, by holding the answer back. Owner choice, 2026-09-29: "Defer to later".

## Acceptance criteria

- AC1: On both engines, a message sent while the agent is running tools reaches the agent before its next step, after all running tool calls finish, and wrapped in the shared framing. The user gets exactly one reply and one progress card for that turn.
- AC2: On both engines, a message sent while the agent is writing final text (no more tool calls) gets a second reply straight after, threaded as a reply to the follow-up where the channel supports it. Nothing is lost.
- AC3: Subagents, scheduled runs and background runs never take mid-turn messages.
- AC4: /stop ends the turn at once. An unread mid-work message is kept as history and starts no turn.
- AC5: A "seen" reaction on chat channels, and a "received" event on the web app and web SDK, mark the moment a mid-work message is taken in.
- AC6: Both engines, including their inline lanes, pass one shared steering conformance suite that uses the same framing text. The Claude-only steering gate is gone.

## Success measure

- Metric: turns where a follow-up arrived while the agent was working, and the share of them answered in one reply (steered) rather than two, counted from the runtime's turn and continuation records.
- Baseline: 0% today; every mid-work follow-up gets a second reply.
- Target: at least 80% of mid-work follow-ups steered into one reply. The rest are ones that arrived while the final text was being written.
- Check date: 2026-12-01

## Roadmap

- TURN-2: Messages sent while the agent works steer its answer
