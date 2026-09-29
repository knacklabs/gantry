---
reader: codex (gpt-6-sol)
read_at: 2026-09-29T07:59:35+00:00
read_hash: dadfed168d667367d18c79d980cd7f03df59bda5
amended_hash: 3170ef6ee45fcea99b9c2f4c337b5ed1cb369970
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc once, then
run `forge read <doc> --amended`:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options. There is no second read.

1. T1 does not pin the protocol that T2, T3 and T4 must share.
   The tasks all need the new `RunnerControlContinuationInput` fields, continuation JSON format, inline `onContinuation` shape, and `RunnerOutputFrame`/`AgentOutput` delivered IDs and reply target. T1 pins only the inbox API. Put these contracts and their shared files in T1 before the adapters and host run in parallel.
   Disposition: keep amended: T1 now pins the continuation input (per-message identity plus renderedText), the close-reason sentinel and control port, the frame's deliveredCommandIds and followupReplyTarget, and MessageSendOptions.replyTo, and owns those files

2. The inbox item shape cannot represent the current continuation batch or reuse `formatMessages` as written.
   A continuation can contain several messages already rendered into one XML string, while `offer` has one `messageId` and only `text`. `formatMessages` needs `NewMessage[]` and a timezone. T1 must pin how each message retains its identity and how the shared framing wraps the existing rendered text.
   Disposition: keep amended: an item is one continuation command with messages {messageId, providerRef}[] plus renderedText; the framing wraps renderedText and doesn't re-render through formatMessages

3. `takeForStep()` confirms delivery too early for the crash rule.
   It marks items delivered when a hook or middleware takes them, before the next model step is confirmed. A crash in that gap would prevent an unread message from reaching the next turn. T1 must pin when delivered IDs become final and test that boundary.
   Disposition: keep amended: takeForStep moves items to in flight; confirmStep, called when the next model step starts, makes them delivered; a crash before confirm leaves them undelivered; tested in T1 and the kit

4. Split: T4 → visible-turn transition and reply-target delivery.
   T4’s scope can change the host turn marker, but outbound `MessageSendOptions`, the output buffer, and Telegram, Discord and Slack send paths have no reply target today and are outside its scope. The second task should own those channel paths and pin how streaming replies carry the target.
   Disposition: keep amended: split: T4 is the visible-turn transition; the new T5 owns the output buffer and the Telegram, Discord and Slack send paths for replyTo, first message only when streaming

5. T5 cannot distinguish `/stop` from an ordinary close using the stated runner contract.
   Both currently use the same `_close` signal. `close(reason: 'stop' | 'end')` has no pinned source for that reason, yet T5 must consume unread items only for `/stop`. Pin the stop reason across the host and both runners before T5.
   Disposition: keep amended: T1 pins the close reason ('stop' | 'end') in the _close sentinel and the inline control port; /stop writes stop; both adapters read it; T6 consumes on stop only

6. T5’s web acknowledgement lacks its routing and event contracts.
   `app.ts` emits outbound events, while continuation routing happens elsewhere; `session.message.received` is absent from `runtime-event-types.ts` and the generated SDK event types. The current reaction path can also run before checking whether routing succeeded. Add those producers and event definitions to T5’s scope and require one event only for an accepted mid-turn route.
   Disposition: keep amended: T6 owns runtime-event-types.ts, the SDK session-events and the regenerated openapi, and the reaction site in message-loop.ts; the event and reaction fire only after an accepted route

7. The conformance tests do not explicitly cover all four adapter paths required by Done when 6.
   T2 and T3 name runner tests, but both inline lanes must pass the same suite too. Pin the kit’s adapter interface in T1 and require runner and inline runs for each engine, including the scheduled-run exclusion.
   Disposition: keep amended: T1 pins the kit's adapter harness interface; T2 and T3 each run it for both the runner and the inline lane, including the scheduled-run exclusion
