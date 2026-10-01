---
slug: steer-running-answer
title: Messages sent while the agent works steer its answer
status: confirmed
saved: 2026-09-29T06:18:16+00:00
confirmed_by: "Ravi"
confirmed_hash: 33811694a352cce50bb12017e7fd438812e684eef99a3cefe0426ea7555da282
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

- **Built on "One message, one turn".** This spec depends on [one-message-one-turn](one-message-one-turn.md) (TURN-1) and its mid-turn confirmation (TURN-1 T4). Whether a message was taken by a turn, and whether it reached the model, is recorded only there:
  - the consumption record says which turn or command took it;
  - the runner's delivered ids say it reached the model.

  The steering inbox is the runner's in-memory view of messages already taken for the running turn. It is not a second record.
- **A message sent while the agent is working steers the current answer.** It is given to the agent at the next step boundary, after the tool calls running at that moment have finished and before the agent's next step. It comes with one shared framing, the same on both engines: new messages arrived while you were working; they may correct or change the current task; apply them now and briefly mention the change.
  - The turn continues as one reply: no second turn, no second "working" card.
  - Text already shown before the message arrived stays on screen. The rest of the answer continues after the step, reflects the change and says so briefly.
  - A steered message counts as steered when its delivery was confirmed during the turn and no second turn was started for it.
- **Fallback when there is no step left.** If the agent is already writing its final text, with no more tool calls, the message is answered in a second reply straight after. Nothing is lost, and the message is never answered before it arrives.
  - On channels that support replies (Telegram, Discord, Slack threads), that second reply is threaded as a reply to the follow-up. If there are several, it replies to the newest.
  - To make that possible, the follow-up's message id and provider reference travel with its continuation input and the runner's follow-up marker, through to outbound delivery.

  Owner choice, 2026-09-29: "Yes, reply to it".
- **What happens to a message that was taken but never read.** This is decided by the runner's delivered ids when the turn ends:
  - /stop: messages not delivered are kept as history and start no turn. Owner choice, 2026-09-29: "Keep as history". This overrides TURN-1's release-to-next-turn rule for the /stop case only.
  - A crash or any other turn end: they go to the next turn (TURN-1's rule).
  - A message delivered in the same instant as /stop counts as delivered.
- **Only the main agent takes steering.** Subagents inside a turn don't. Scheduled and background runs never take mid-turn messages, as today.
- **Acknowledgement means "received for the running turn".** It is sent when Gantry routes the message to the running turn, which is the same moment as today's "seen" reaction:
  - chat channels with reactions (Telegram, Discord, Slack) keep the "seen" reaction;
  - the web app and web SDK get one "received" event carrying the message id and the turn id. Owner choice, 2026-09-29: "Yes, add an event".
  - Teams has no reaction path and doesn't connect today, so it gets none until it does.

  Acknowledgement does not claim the model has read the message; the delivered ids record that.
- **Engine-neutral by construction.** The inbox, the framing text, the delivered and undelivered rules, and the conformance tests live in shared runtime code. Each engine has only a thin adapter: the Claude `PostToolBatch` hook, and the DeepAgents `beforeModel` middleware. The old Claude-only steering gate is deleted.
- **Out of scope for now:** folding a message that arrives at the very last moment into the final answer, by holding the answer back. Owner choice, 2026-09-29: "Defer to later".

## Acceptance criteria

- AC1: On both engines, a message sent while the agent is running tools reaches the agent before its next step, after all running tool calls finish, and wrapped in the shared framing. No second turn or progress card is started; text already shown stays and the rest of the answer reflects the change.
- AC2: On both engines, a message sent while the agent is writing final text (no more tool calls) gets a second reply straight after, threaded as a reply to the newest follow-up where the channel supports it. Nothing is lost.
- AC3: Subagents, scheduled runs and background runs never take mid-turn messages.
- AC4: /stop ends the turn at once. A mid-work message not yet delivered to the model is kept as history and starts no turn. After a crash, an undelivered message goes to the next turn.
- AC5: When a mid-work message is routed to the running turn, Telegram, Discord and Slack show the "seen" reaction, and the web app and web SDK receive one "received" event with the message id and turn id.
- AC6: Both engines, including their inline lanes, pass one shared steering conformance suite that uses the same framing text. The Claude-only steering gate is gone.

## Success measure

- Metric: of the follow-ups taken by a running turn (TURN-1 consumption record), the share whose delivery was confirmed during that turn with no second turn started (steered), versus answered in a second reply.
- Baseline: 0% today; every mid-work follow-up gets a second reply.
- Target: at least 80% of mid-work follow-ups steered into one reply. The rest are ones that arrived while the final text was being written.
- Check date: 2026-12-01

## Roadmap

- TURN-2: Messages sent while the agent works steer its answer
