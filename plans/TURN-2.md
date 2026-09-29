# Messages sent while the agent works steer its answer

5 parts · Risks: runner protocol change on both engines · New moving parts: none

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
2. **Fallback when the final answer is already being written.** The message gets a second reply straight after, threaded to the newest follow-up where the channel supports replies (Telegram, Discord, Slack threads). Nothing is lost.
3. **Only the main agent steers.** Subagents, scheduled runs and background runs never take mid-turn messages.
4. **/stop and crashes.** /stop ends the turn at once. A mid-work message not yet delivered to the model is kept as history and starts no turn. After a crash, an undelivered message goes to the next turn.
5. **Acknowledgement on every channel.** When a mid-work message is routed to the running turn:
   - Telegram, Discord and Slack show the "seen" reaction;
   - the web app and web SDK receive one "received" event with the message id and the turn id.
6. **One shared behaviour.** Both engines, including their inline lanes, pass one shared steering conformance suite that uses the same framing text. The Claude-only steering gate is deleted.

## Risks

- **Runner protocol change on both engines.** Continuation input gains the follow-up's message id and provider reference, and the runner's follow-up marker carries them to outbound delivery. Both runners and the host change in this story.
- **How much weight the Claude engine gives injected context.** The Claude `PostToolBatch` hook delivers text as a system-reminder, not a user turn, so the shared framing has to carry the authority. The live agent end-to-end check verifies it. If it proves weak, the adapter can switch to the SDK's native queued user message without changing the shared contract.
- **Order dependency on TURN-1.** This story needs TURN-1 T4 (the delivered ids, and close returning undelivered text) merged before its first task starts.
- **One-way steps:** none. There's no data migration, and deleting the old gate is a code-only change.

## For the builders

**The shared contract, pinned by T1:** a new `apps/core/src/runner/steering-inbox.ts`, engine-neutral.
- `offer(items: {commandId, messageId, providerRef, text}[])`: fed by the IPC pump (subprocess runners) or the control-port subscription (inline lanes).
- `takeForStep(): {text, commandIds} | null`: called at every step boundary. It returns all pending items wrapped in the shared framing (`STEERING_FRAMING`, `frameSteering()`, which reuses the existing `formatMessages` XML in `messaging/router.ts`) and marks them delivered.
- `takeForNextTurn()`: the fallback when no boundary comes. It returns the raw items; the runner sets `continuedByFollowup` and passes the newest follow-up's message id and provider reference for the threaded reply.
- `delivered(): string[]` feeds TURN-1 T4's delivered-ids field. `close(reason: 'stop' | 'end'): items[]` returns what wasn't delivered.
- The framing text lives only here: new messages arrived while you were working; they may correct or change the current task; apply them now and briefly mention the change.
- T1 also ships the conformance kit, `apps/core/src/runner/steering-conformance.ts`: a table of scenarios each engine adapter must pass (a tool batch, a parallel batch, final text with no tools, close during a batch, a subagent ignored, a scheduled run ignored).

**Engine adapters stay thin.**
- **Claude:** a `PostToolBatch` hook returns `additionalContext: takeForStep()?.text`, only when `agent_id` is absent (main thread). At `result`, `takeForNextTurn()` goes through `stream.pushContent`. `SteeringDeliveryGate` is deleted, and the scheduled-run "Outcome:" nudge pushes directly.
- **DeepAgents:** a `beforeModel` middleware appends `HumanMessage(takeForStep().text)`. The pre-turn drain in `runner/index.ts` is removed so nothing is delivered twice. Subagents get only their own middleware, so it is main-thread only by construction.

**Host side (T4, T5).**
- The continuation handler starts a visible turn only when the runner was idle-waiting.
- A mid-turn follow-up starts nothing; the fallback's `continuedByFollowup` marker starts the second visible reply, threaded with its reply target.
- On /stop, TURN-1's release rule is overridden: undelivered items are consumed as `stopped`, which makes them history.
- Acknowledgement stays at routing time. The web "received" event is added next to the existing continuation receipts.

**Keep:**
- scheduled and background runs excluded from continuations (`isTaskRun`);
- the "seen" reaction at routing time;
- TURN-1's consumption record as the only record of read state.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | Shared steering inbox and conformance kit | `steering-inbox.ts` with the framing, the take/fallback/close/delivered API and the item shape carrying the reply target; `steering-conformance.ts`; a decision record for the steering contract | 6 | `apps/core/src/runner/steering-inbox.ts`, `apps/core/src/runner/steering-conformance.ts`, `docs/decisions/*` | Inbox unit tests: take at a step, fallback, close('stop') and close('end') return undelivered, delivered ids, framing text used verbatim | | no |
| T2 | Claude engine adapter | The main-thread `PostToolBatch` steering hook; the result-boundary fallback with the reply target; the gate deleted; the nudge pushes directly. Runner and inline lane. | 1, 2, 3 | `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-setup.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-messages.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/steering-delivery-gate.ts` (delete), `apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/index.ts` | The conformance kit against a mocked SDK stream (tool batch, parallel batch, final text, close, subagent `agent_id` ignored); one live agent end-to-end check that a correction changes the answer | T1 | yes |
| T3 | DeepAgents engine adapter | The `beforeModel` steering middleware; live-control feeds the inbox; the pre-turn drain removed; the fallback with the reply target. Runner and inline lane. | 1, 2, 3 | `apps/core/src/adapters/llm/deepagents-langchain/runner/live-control.ts`, `apps/core/src/adapters/llm/deepagents-langchain/runner/index.ts`, `apps/core/src/adapters/llm/deepagents-langchain/runner/deep-agent-runner.ts`, new `apps/core/src/adapters/llm/deepagents-langchain/runner/steering-middleware.ts`, `apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts` | The conformance kit with a fake chat model through the real `createDeepAgent` graph: a HumanMessage after all ToolMessages, no double delivery, the fallback | T1 | yes |
| T4 | One visible reply and the threaded fallback | The handler starts a visible turn only when the runner was idle. The fallback marker starts the second reply, carrying the follow-up's message id and provider reference to outbound delivery as the reply target. | 1, 2, 3 | `apps/core/src/runtime/group-queue.ts`, `apps/core/src/runtime/group-queue-live-turn-hooks.ts`, `apps/core/src/runtime/group-queue-types.ts`, `apps/core/src/runtime/group-processing.ts`, `apps/core/src/runtime/continuation-input.ts` | Group-processing tests: a mid-turn follow-up gives one generation and one message; the fallback gives two, the second threaded to the newest follow-up; an idle follow-up gives a new turn; a scheduled run takes none | T1 | yes |
| T5 | /stop keeps unread messages as history; web "received" event | On /stop, undelivered items are consumed as `stopped`; after a crash, released as TURN-1 does. The web app and SDK "received" event carries the message id and turn id. | 4, 5 | `apps/core/src/runtime/continuation-receipts.ts`, the /stop handling in `apps/core/src/runtime/group-session-command-state.ts`, `apps/core/src/channels/app.ts`, `packages/sdk/src/session-events.ts` | /stop during a batch leaves the undelivered message as history and starts no turn; a crash releases it to the next turn; the web event is emitted once with both ids; the reaction on Telegram, Discord and Slack is unchanged | T4 | yes |

New moving parts: none

## Notes

- **Order:** start T1 only after TURN-1 T4 is merged. T2, T3 and T4 can run in parallel after T1.
- **Owner choices, 2026-09-29:**
  - /stop keeps unread messages as history;
  - the fallback reply is threaded to the follow-up;
  - the web gets a "received" event;
  - last-moment folding is deferred.
- **Deferred:** folding a message that arrives while the final text is being written into that answer (holding the answer back). Revisit after steering is live.
