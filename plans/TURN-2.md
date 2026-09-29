# Messages sent while the agent works steer its answer

6 parts · Risks: runner protocol change on both engines · New moving parts: none

## What changes for you

- If you send a correction while the agent is working ("use the other file", "also check staging"), it takes it in at its next step and changes course. You get one answer that reflects it, not an outdated answer followed by a second one.
- Text already shown stays on screen. The rest of the answer follows your correction and briefly says so.
- If your message arrives while the agent is already writing its final answer, you get a second reply straight after, threaded to your message where the chat supports it.
- 👀 still shows that your message was received. The web app and SDK get a matching "received" event.
- /stop still stops at once. A message the agent hadn't read yet is kept as history and doesn't start a new turn.
- It works the same on both agent engines and on every chat channel.

## Why

See the spec: [Messages sent while the agent works steer its answer](../docs/specs/steer-running-answer.md). Today a mid-work message is held back until the whole answer is finished, then answered as a new question. The user gets an outdated reply followed by a corrected one, and a new "working" card starts while the first answer is still streaming. Both engines do this with their own code.

This story builds on "One message, one turn" (TURN-1). That story owns the record of which turn took a message, and the runner's confirmation that it reached the model (TURN-1 T4). This story adds no second record.

## Done when

1. **A mid-work message steers the current answer, on both engines.** A message sent while the agent is running tools reaches it at the next step boundary, after the running tool calls finish and before its next step, wrapped in the one shared framing.
   - No second turn or progress card is started.
   - Text already shown stays; the rest of the answer reflects the change.
2. **Fallback when the final answer is already being written.** The message gets a second reply straight after. Where the channel supports replies (Telegram, Discord, Slack threads), it is threaded to the newest follow-up, on the first message of that reply. Nothing is lost.
3. **Only the main agent steers.** Subagents, scheduled runs and background runs never take mid-turn messages.
4. **/stop and crashes.** /stop ends the turn at once. A mid-work message not yet delivered to the model is kept as history and starts no turn. A message counts as delivered only once the model's next step has started; after a crash before that, it goes to the next turn.
5. **Acknowledgement on every channel.** Only when a mid-work message is accepted by the running turn:
   - Telegram, Discord and Slack show the "seen" reaction;
   - the web app and web SDK receive one "received" event with the message id and the turn id.
6. **One shared behaviour.** Each engine runs the one shared steering conformance suite twice, once for its runner and once for its inline lane, with the same framing text. The Claude-only steering gate is deleted.

## Risks

- **Runner protocol change on both engines.** Continuation input gains the follow-up's message id and provider reference, and the runner's follow-up marker carries them to outbound delivery. Both runners and the host change in this story.
- **How much weight the Claude engine gives injected context.** The Claude `PostToolBatch` hook delivers text as a system-reminder, not a user turn, so the shared framing has to carry the authority. The live agent end-to-end check verifies it. If it proves weak, the adapter can switch to the SDK's native queued user message without changing the shared contract.
- **Order dependency on TURN-1.** This story needs TURN-1 T4 (the delivered ids, and close returning undelivered text) merged before its first task starts.
- **One-way steps:** none. There's no data migration, and deleting the old gate is a code-only change.

## For the builders

**The shared protocol, pinned by T1 before anything runs in parallel.**
- **Continuation input** (`runtime/runner-control-port.ts` `RunnerControlContinuationInput`, and the JSON written by `runtime/continuation-input.ts`) becomes:
  - `commandId`;
  - `messages: {messageId, providerRef}[]`, each message keeping its own identity;
  - `renderedText`, the existing formatted XML for the whole batch, unchanged;
  - `threadId`.

  The inline lanes' `onContinuation` receives the same shape.
- **The close signal carries a reason.** The `_close` sentinel file content and the inline control port's close both carry `{reason: 'stop' | 'end'}`. /stop writes `stop`; every other close writes `end`.
- **The runner output frame** (`runner/runner-frame.ts`) carries two things:
  - `deliveredCommandIds`, the field TURN-1 T4 added, now fed by the inbox;
  - `followupReplyTarget: {messageId, providerRef} | null`, set when the fallback runs: the newest message of the newest undelivered command.
- **Sending:** `MessageSendOptions` (`domain/types.ts`) gains `replyTo?: {messageId, providerRef}`.

**The inbox:** `apps/core/src/runner/steering-inbox.ts`, engine-neutral.
- An item is one continuation command: `{commandId, messages, renderedText}`.
- `takeForStep()` returns all pending items. Each item's `renderedText` is wrapped once in the shared framing (`STEERING_FRAMING`, which lives only here). The items move to "in flight".
- `confirmStep()` is called by the adapter when the next model step actually starts (Claude: the first assistant event after the hook; DeepAgents: the model call after the middleware). Only then do in-flight items become delivered. After a crash before confirmation, they are undelivered, so TURN-1's rule sends them to the next turn.
- `takeForNextTurn()` is the fallback. It returns the raw items and the reply target.
- `delivered()` returns confirmed command ids only. `close(reason)` returns everything pending or in flight.

**The conformance kit:** `apps/core/src/runner/steering-conformance.ts`. It defines a small adapter harness interface (start a turn, emit a tool batch, emit final text, close with a reason, mark as subagent or scheduled). Scenarios: a tool batch, a parallel batch, final text with no tools, close('stop') during a batch, a crash before confirm, a subagent ignored, a scheduled run ignored. Each engine runs it twice: once for its subprocess runner and once for its inline lane.

**Engine adapters stay thin.**
- **Claude:** the main-thread `PostToolBatch` hook returns `additionalContext` from `takeForStep()`, and the next assistant event calls `confirmStep()`. At `result`, `takeForNextTurn()` goes through `stream.pushContent` and the frame's reply target. `SteeringDeliveryGate` is deleted, and the "Outcome:" nudge pushes directly.
- **DeepAgents:** a `beforeModel` middleware appends `HumanMessage(takeForStep().text)` and confirms when the model call begins. The pre-turn drain in `runner/index.ts` is removed.
- Both read the close reason from the sentinel or control port.

**Host.**
- **T4:** the continuation handler starts a visible turn only when the runner was idle-waiting. A mid-turn follow-up starts nothing. The fallback marker starts the second visible reply.
- **T5:** threads `followupReplyTarget` from the frame through the output buffer into `MessageSendOptions.replyTo`, and the Telegram, Discord and Slack send paths use it. Streaming or edit-in-place replies apply it to the first message of the reply only.
- **T6:** on a close with reason `stop`, undelivered items are consumed as `stopped`, which makes them history. The "seen" reaction and the new web `session.message.received` event (message id and turn id) fire only after the route to the running turn was accepted.

**Keep:**
- scheduled and background runs excluded (`isTaskRun`);
- TURN-1's consumption record as the only record of read state.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | Shared steering protocol, inbox and conformance kit | Continuation input with per-message identity; close with a reason; frame delivered ids and reply target; `MessageSendOptions.replyTo`; `steering-inbox.ts` with in-flight/confirm; `steering-conformance.ts` with the adapter harness; a decision record | 6 | `apps/core/src/runner/steering-inbox.ts`, `apps/core/src/runner/steering-conformance.ts`, `apps/core/src/runtime/runner-control-port.ts`, `apps/core/src/runtime/continuation-input.ts`, `apps/core/src/runner/runner-frame.ts`, `apps/core/src/domain/types.ts` (`MessageSendOptions` only), `docs/decisions/*` | Inbox unit tests: take, confirm, crash before confirm not delivered, close('stop') and close('end') return undelivered, framing wraps `renderedText` verbatim. Round-trip tests for the continuation JSON and the close sentinel reason. A frame field test. | | no |
| T2 | Claude engine adapter | The main-thread `PostToolBatch` hook with confirm on the next assistant event; the result-boundary fallback with the reply target; the close reason read; the gate deleted; the nudge pushes directly. Runner and inline lane. | 1, 2, 3 | `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-setup.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-messages.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/ipc-input.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/steering-delivery-gate.ts` (delete), `apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/index.ts` | The conformance kit run for both the Claude runner (mocked SDK stream) and the Claude inline lane; one live agent end-to-end check that a correction changes the answer | T1 | yes |
| T3 | DeepAgents engine adapter | The `beforeModel` steering middleware with confirm on the model call; live-control feeds the inbox and reads the close reason; the pre-turn drain removed; the fallback with the reply target. Runner and inline lane. | 1, 2, 3 | `apps/core/src/adapters/llm/deepagents-langchain/runner/live-control.ts`, `apps/core/src/adapters/llm/deepagents-langchain/runner/index.ts`, `apps/core/src/adapters/llm/deepagents-langchain/runner/deep-agent-runner.ts`, new `apps/core/src/adapters/llm/deepagents-langchain/runner/steering-middleware.ts`, `apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts` | The conformance kit run for both the DeepAgents runner (a fake chat model through the real `createDeepAgent` graph) and the DeepAgents inline lane | T1 | yes |
| T4 | One visible reply | The continuation handler starts a visible turn only when the runner was idle; a mid-turn follow-up starts no turn or card; the fallback marker starts the second visible reply | 1, 3 | `apps/core/src/runtime/group-queue.ts`, `apps/core/src/runtime/group-queue-live-turn-hooks.ts`, `apps/core/src/runtime/group-queue-types.ts`, `apps/core/src/runtime/group-processing.ts` | Group-processing tests: a mid-turn follow-up gives one generation and one message; the fallback gives two; an idle follow-up gives a new turn; a scheduled run takes none | T1 | yes |
| T5 | Threaded fallback reply | `followupReplyTarget` flows from the frame through the output buffer into `MessageSendOptions.replyTo`; Telegram, Discord and Slack send the fallback as a reply to the newest follow-up; streaming applies it to the first message only | 2 | `apps/core/src/runtime/group-output-buffer.ts`, `apps/core/src/channels/telegram/channel-delivery.ts`, `apps/core/src/channels/discord/delivery.ts`, `apps/core/src/channels/slack/channel-delivery.ts` | Delivery tests per channel: the reply-to is set on the first message of the fallback reply, not on normal replies; the output buffer passes the target through; streaming carries it once | T4 | yes |
| T6 | /stop keeps unread messages as history; acknowledgement after routing | A close with reason `stop` consumes undelivered items as `stopped`; `end` and crashes release them (TURN-1). The web and SDK `session.message.received` event carries the message id and turn id. The "seen" reaction and the event fire only after an accepted route. | 4, 5 | `apps/core/src/runtime/continuation-receipts.ts`, `apps/core/src/runtime/group-session-command-state.ts` (/stop), `apps/core/src/runtime/message-loop.ts` (reaction site only), `apps/core/src/domain/events/runtime-event-types.ts`, `apps/core/src/channels/app.ts`, `packages/sdk/src/session-events.ts`, `packages/sdk/src/generated/openapi.ts` (regenerated) | /stop during a batch leaves the undelivered message as history and starts no turn; a crash releases it; a rejected route gives no reaction and no event; an accepted route gives exactly one event with both ids | T4 | yes |

New moving parts: none

## Notes

- **Order:** start T1 only after TURN-1 T4 is merged. T2, T3 and T4 can run in parallel after T1; T5 and T6 follow T4.
- **Owner choices, 2026-09-29:**
  - /stop keeps unread messages as history;
  - the fallback reply is threaded to the follow-up;
  - the web gets a "received" event;
  - last-moment folding is deferred.
- **Deferred:** folding a message that arrives while the final text is being written into that answer (holding the answer back). Revisit after steering is live.
