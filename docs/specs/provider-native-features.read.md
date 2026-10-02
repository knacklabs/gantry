---
reader: codex (gpt-6.1-sol)
read_at: 2026-10-02T07:17:15+00:00
read_hash: 80b6e866e5054c051d9cb86599f50d38fd2ea8ba
round: 4
passed: yes
doc_seen: 80b6e866e5054c051d9cb86599f50d38fd2ea8ba
spec_seen: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
notes_seen: dc0070d24e7abc6debeae8a36c2e830d2609109c
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc, then run
`forge read <doc>` again for the next round, until a round finds nothing:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options.

## Round 1

1. AC6 promises native top-level Slack streaming where Slack rejects it.
   [Slack’s method reference](https://docs.slack.dev/reference/methods/chat.startStream/) permits omitted `thread_ts` only in channels that act as one session, such as Slack Code; ordinary channels return `invalid_thread_ts`. Pin supported destinations and the behaviour elsewhere before approving PROV-4.
   Disposition: keep amended: Slack streams natively in threads, direct messages and assistant threads; top-level channel replies stream by edits; AC6 matches

2. AC3 leaves Slack’s shared edit budget and cooldown undefined.
   Two replies editing every 1.2 seconds produce about 100 edits/minute against the stated 50/minute allowance. [Slack limits requests per method, app and workspace](https://docs.slack.dev/apis/web-api/rate-limits/), and a refusal pauses that method across workspace tokens. Specify shared pacing for edits as well as native appends, including progress updates; extend AC3 to cover fallback edits and another reply attempting updates during the cooldown.
   Disposition: keep amended: one shared budget per Slack method per workspace for all replies and progress, with a fair share each; a refusal pauses everything sharing it; AC3 covers fallback edits

3. Unproven: item 1: Telegram replies exceeding 4,096 characters.
   Both [drafts](https://core.telegram.org/bots/api#sendmessagedraft) and [normal text messages](https://core.telegram.org/bots/api#sendmessage) have that limit. Pin which portion remains in the draft and how the complete reply is delivered without truncation. Reuse the existing delivery splitter and qualify AC1’s “one normal message” promise.
   Disposition: keep amended: the final reply is split by the existing splitter; the draft shows the newest part; AC1 qualified

4. Unproven: item 2: durable partial output and stale Stop events.
   Telegram’s `keep_on_stop` remains temporary; preserving partial text requires sending a normal message. Specify terminal delivery exactly once, including Stop racing completion. Bind provider Stop identifiers to the original turn and define duplicate, stale and already-finished outcomes: the existing [stop router](/apps/core/src/runtime/live-turn-routing.ts:83) resolves the currently active turn, so blindly forwarding a delayed event could stop its successor.
   Disposition: cut: owner chose /stop as the only way to stop; no native Stop buttons

5. Slack’s setup risk understates what fails without agent configuration.
   [Slack requires an app declared as an agent to create sessions](https://docs.slack.dev/ai/agent-sessions/); missing configuration can therefore remove native status too, rather than “just” Stop. Pin required settings, scopes and subscriptions, and the reply/progress behaviour when each is absent. Include that degraded installation in acceptance coverage.
   Disposition: keep amended: names the agent declaration, scopes and events, gantry doctor reports them, and Gantry degrades to native task steps without the status line; AC6 covers the degraded install

6. AC1’s uninterrupted draft promise conflicts with refusal handling and ordinary message delivery.
   A cooldown longer than the draft’s lifetime prevents the promised refresh; Telegram also clears the retained draft when the bot sends a message. Existing [progress delivery](/apps/core/src/channels/telegram/channel-delivery.ts:325) sends ordinary messages. Specify how progress and permission prompts interact with the draft, and what users see during long refusals; qualify the two-second and refresh guarantees accordingly.
   Disposition: keep amended: progress lives inside the draft in direct chats; a permission prompt clears the draft and a new one follows; a long refusal may expire the draft, which then comes back with the full text

7. Unproven: item 1: crash between displaying a draft and queuing its final delivery.
   Risks promises eventual outbox delivery after a crash, but the current [streaming buffer](/apps/core/src/runtime/group-output-buffer.ts:139) holds generation text in memory and persists it on completion. Pin how an interrupted turn recovers that reply and add a restart acceptance case covering this window and final delivery without duplication.
   Disposition: keep amended: a crash mid-draft is recovered by One message, one turn's rules with exactly one final reply; AC1 adds the restart case

## Round 2

8. Disputed keep 7: the referenced recovery rules do not distinguish drafts from delivered replies.
   [One message, one turn](/docs/specs/one-message-one-turn.md:42) keeps inputs consumed once any reply was sent. Today’s [streaming settlement](/apps/core/src/runtime/group-processing.ts:490) counts successful live updates as delivery. Pin that temporary drafts do not commit reply delivery, and make AC1’s restart case exercise a successfully displayed draft before any normal message is sent.
   Disposition: keep amended: a draft never counts as a reply; only the first normal message commits input; AC1 restart case is after a shown draft and before any normal message

9. Disputed keep 6: restoring “the full text so far” contradicts the draft overflow rule.
   After a long refusal with more than 4,096 characters buffered, Telegram cannot display that full text in one draft. Specify that restoration shows the newest part, while final delivery preserves the complete reply, and include this combined case in AC1.
   Disposition: keep amended: after a long refusal the draft shows the newest part within the limit, and the final reply carries everything; AC1 covers it

10. Disputed keep 1: ordinary unthreaded Slack direct messages still lack a pinned native route.
    [Slack permits threadless streaming only in whole-session channels](https://docs.slack.dev/reference/methods/chat.startStream/). AC6 promises native streaming for direct messages without specifying whether an ordinary DM reply moves into a thread or uses edit fallback. Pin the placement and cover an incoming DM without `thread_ts`.
   Disposition: keep amended: an unthreaded direct message's reply stays top-level, as today, and streams by edits; AC6 covers it

11. Disputed keep 5: the blanket event-subscription requirement conflicts with keeping native Stop disabled.
    [Slack displays Stop when `agent_session_stopped` is subscribed](https://docs.slack.dev/ai/agent-sessions/#stopping-a-session), and warns when it is absent. Explicitly exclude that subscription from required setup and doctor recommendations; otherwise following the setup guidance can violate AC2.
   Disposition: keep amended: Gantry never subscribes to agent_session_stopped, and setup and doctor never recommend it; AC6 checks no Stop appears

## Round 3

12. Disputed keep 8: delaying input consumption until the first normal reply contradicts the referenced intake contract.
    [One message, one turn](/docs/specs/one-message-one-turn.md:42) consumes input atomically when a turn takes it, then releases it on failure before replying. Input is therefore consumed while a draft shows, not “still unconsumed.” Keep that ownership rule; specify that drafts leave reply-delivery status unset and recovery releases the failed turn’s input before retrying. AC1 should also prove a second worker cannot take the input while the draft’s turn remains active.
   Disposition: keep amended: the turn takes input as One message, one turn defines; a draft never marks the reply as sent; a failed turn before any normal message releases its input under the existing failure rule; AC1 adds the second-worker case

## Round 4

No findings.
