---
reader: codex (gpt-6.1-sol)
read_at: 2026-10-02T04:27:49+00:00
read_hash: 9aad7098a45e9f57d18fe55f4ed3a0909d8f9691
round: 6
passed: yes
doc_seen: 9aad7098a45e9f57d18fe55f4ed3a0909d8f9691
spec_seen: e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
notes_seen: d31612a1badd22e1f49c50f4da58bf1ac66afccb
---
# Cold read notes

Written by `forge read`. Under every finding, write one disposition line, amend the doc, then run
`forge read <doc>` again for the next round, until a round finds nothing:

- `Disposition: cut` when the doc was edited to remove it;
- `Disposition: defer` when the item moved to the spec's Out of scope;
- `Disposition: keep <one-line reason>` otherwise.

Only a genuine trade-off goes to the human, as a question with options.

## Round 1

1. AC3 contradicts the confirmed ordering contract.
   [One message, one turn](docs/specs/one-message-one-turn.md) explicitly presents batches by provider time, then receive number; this spec says the agent sees receive order exclusively. Decide which rule survives and amend the confirmed contract explicitly.
   Disposition: keep amended: taking and batching follow receive order; how a batch is shown stays as One message, one turn defines it

2. AC1 and AC2 promise answers for events that the confirmed intake deliberately excludes.
   Mention-free group messages and overloaded messages remain history only; cancelled batches start no turn. Qualify “gets the message once” and “answered once” so these existing behaviours remain buildable.
   Disposition: keep amended: the guarantee is now that every saved event reaches intake exactly once, and intake's existing rules decide whether it starts a turn

3. AC1 does not define recovery when saving the inbox itself fails.
   Acknowledging after saving protects only committed events. Discord’s current [gateway](apps/core/src/channels/discord/gateway.ts) advances its resume sequence before dispatch and keeps connection state in memory. Pin each edge’s replay/checkpoint contract, including database failure and takeover before inbox commit, or narrow the guarantee.
   Disposition: keep amended: each edge acknowledges or advances its checkpoint only after the inbox commit; provider redelivery covers failed saves; events a provider gave up on are logged and fall back to the history re-read

4. Inbox de-duplication lacks an identity and fan-out contract.
   “Provider’s own event id” does not distinguish message identity from edit, delete or interaction identity, nor specify account scoping. Existing Slack ingestion fans one connection’s events out to multiple logical accounts. Define which delivery is a duplicate and which destinations must each receive it.
   Disposition: keep amended: duplicate identity is connection, kind and provider id; fan-out to account routes happens in unpack, one copy per route

5. Unproven: items 1–2: a crash between unpacking and recording intake completion.
   Saving a canonical message, creating its intake work and marking the inbox event complete must recover as one logical operation. The acceptance cases omit crashes between those writes, where replay can duplicate input or leave it stranded.
   Disposition: keep amended: unpack saves the message, writes intake and marks the event done in one transaction; AC1 covers crashes at each step

6. Ordered unpacking can prevent `/stop` and approvals from being handled.
   A failed attachment at the head of a raw channel blocks later events, potentially across every thread there. The confirmed intake requires session commands immediately. Pin the control-event exception and what happens to ordering when an event is set aside or later retried.
   Disposition: keep amended: a stuck event blocks only its own thread for at most 2 minutes, then is set aside; session commands and taps skip the line

7. AC4 and AC7 leave the send-before-receipt crash window unresolved.
   A provider can accept a send before the host records its receipt; blind retry can duplicate it. [Current recovery](apps/core/src/jobs/outbound-delivery-recovery.ts) explicitly treats this as ambiguous, and the confirmed permission spec permits one extra prompt copy. Specify reconciliation or idempotency guarantees, accepted exceptions, and the `send_message` result for uncertain delivery.
   Disposition: keep amended: an ambiguous send is resent at most once, and provider de-duplication such as Discord's nonce is used where it exists; send_message reports delivered only after confirmation

8. The fixed address set contradicts permission-approved cross-chat sending.
   The outbox must reject every address outside the turn’s original set, yet a gated tool may intentionally send elsewhere. Define how a successful permission decision authorizes that destination. Also distinguish permission-question delivery from ordinary agent output to a policy address.
   Disposition: keep amended: addresses the permission gate allows join the turn's set; approval cards are accepted only at the approval address

9. Cross-provider approver authority is undefined.
   The confirmed permission flow uses the requester conversation’s existing approvers; this spec introduces destination-provider identities without saying who authorizes them. Pin the approver policy and identity scope, including absent configuration and revocation while a request waits; keep saved grants scoped to the requester.
   Disposition: keep amended: the approval address chat's approvers, checked at tap time (owner choice 2026-10-02); falls back to the requester's approvers when none is set

10. Parking an approval does not specify how the approved operation continues.
    “Starts a turn … with the result” leaves open whether the pending tool executes, the old turn resumes, or the agent plans again. Define the durable pending action, the scope and equality rule for repeated asks, and cancellation precedence. Unproven: item 6: crashes after claiming an answer, and `/stop` racing an answered request whose continuation is queued.
   Disposition: keep amended: the record holds the action key; the turn waits as in 0053, then parks; a late answer starts a turn in the same session with a one-time allowance; state changes are conditional updates, so the first to land wins

11. The capability fallbacks contradict unconditional approval behaviour.
    Providers without editing cannot update the requester message in place; providers without threads cannot group cards as promised. Numbered answers need an unambiguous request reference, and closed-window templates need selection, provisioning and failure behaviour. Pin these outcomes before AC8 promises WhatsApp requires no shared-core changes.
   Disposition: keep amended: each capability gap has a defined outcome, request codes for typed answers, and templates chosen at provider setup with failures listed for the admin

12. Unproven: item 7: an old owner resumes after ownership transfers.
    A dead-host test does not cover a paused or disconnected host returning after another host takes over. Specify fencing for conversation writes, connection checkpoints and outbound work; reuse the existing worker-coordination fencing contract and test stale-owner refusal.
   Disposition: keep amended: leases and outbox claims carry the existing fencing number; a returning old owner is refused; AC7 tests it

13. Edits and deletes enter the inbox without a defined downstream effect.
    Unpack is described only as producing a message. State what an edit or delete does before intake, during a turn and after a reply, including missing targets and repeated delivery. Otherwise providers can implement incompatible behaviour while satisfying the stated message tests.
   Disposition: keep amended: defined edit and delete effects before and after intake, and for missing targets

14. Durable raw events and files have no bounded retention contract.
    The confirmed permission spec bounds completed records to 30 days, but this spec adds raw inbox payloads, set-aside events and object-storage files without expiry or cleanup rules. Define retention and protected active references, including how long de-duplication must survive after payload cleanup.
   Disposition: keep amended: 30-day retention for inbox, outbox and ended approvals; set-aside events kept until resolved or 30 days; nothing in use is deleted

## Round 2

15. Disputed keep 10: a saved-approval key does not uniquely identify a pending action.
    The confirmed permission spec matches programs or capabilities, so two calls with different arguments can share that key. Pin a separate pending-request identity, scoped to the requester agent and conversation, and define which callers a joined request resumes. Preserve the chosen breadth of saved approvals.
   Disposition: keep amended: the request holds the tool and its exact input; joining needs the same tool, input, agent and conversation; one answer applies to every joined caller; saved approvals keep their normal breadth

16. Disputed keep 10: conditional answer updates do not close the continuation crash window.
    A crash after marking the request answered but before queuing its new turn can strand the action; replay can also queue it twice. Require durable, idempotent continuation creation and extend AC6 to exercise that exact boundary.
   Disposition: keep amended: the answer and the new turn's intake work are written in one transaction keyed by the request; AC6 adds a crash right after the answer

17. Parking conflicts with the confirmed scheduled-job lifecycle.
    This spec keeps a request open when its turn reaches its wait limit and resumes in the same agent session. The permission spec closes job prompts at their deadline and keeps job sessions separate from chat. Explicitly preserve those rules for job-originated requests, including restart and late answers.
   Disposition: keep amended: job requests keep the permission spec's job rules (deadline, late tap applies nothing, own session); only the card's destination changes

18. Unproven: item 3: `/stop` overtakes a message that later finishes unpacking.
    The command cancels intake’s waiting work, but the older message may still be downloading or set aside. Its later arrival can restart work the user stopped. Define how `/stop` covers earlier inbox events and test delayed unpacking after cancellation.
   Disposition: keep amended: /stop covers every earlier event in its thread, including ones still unpacking or set aside, which arrive later as history; AC3 tests it

19. Disputed keep 13: ignoring a missing delete target can resurrect a deleted message.
    A message can be set aside, allowing its delete to proceed and be ignored because no canonical message exists. Retrying the original then puts deleted content into intake. Preserve edits and deletes against pending inbox targets, and test that retry cannot undo them.
   Disposition: keep amended: edits and deletes against targets still in the inbox apply when the target is unpacked, including after an admin retry; AC3 tests it

20. Disputed keep 7: uncertain delivery is not limited to host crashes.
    A provider can accept a send before its response times out or the connection fails. Ordinary retry can then duplicate it outside the stated exception. Apply the bounded ambiguity rule to these failures too. Discord’s nonce protection also requires `enforce_nonce` and lasts only a few minutes; a nonce alone is insufficient. [Discord’s message API](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx)
   Disposition: keep amended: the at-most-once-more rule covers timeouts and dropped connections too; Discord uses the nonce with enforce_nonce, within its window

21. Unproven: item 4: a stale stream edit lands after the final text.
    Repeating an edit avoids creating another message, but can still overwrite newer content. Database fencing cannot retract an already-issued provider request. Pin recovery to the newest desired text and test a delayed old edit landing after the final update.
   Disposition: keep amended: after any uncertain stream edit, the final text is sent once more after the provider timeout; AC4 tests a delayed old edit

22. Deleting never-unpacked events is an irreversible loss absent from Risks.
    The new retention rule deletes set-aside raw payloads after 30 days, potentially removing the only recoverable copy. List that loss explicitly under Risks and require a retention check proving waiting or referenced records remain protected.
   Disposition: keep amended: listed under Risks as one-way; the retention test proves waiting or referenced records stay

## Round 3

23. Disputed keep 21: waiting past a timeout does not guarantee that an older edit has finished.
    An uncertain request can commit after the final repair, and the repair itself can fail. No declared provider guarantee bounds that delay. Pin how outstanding edits become harmless, or narrow the “always ends on final text” promise and define the visible failure. AC4 must test an old edit landing after the repair.
   Disposition: keep amended: one edit in flight per stream; an uncertain edit gets one repair after the timeout, and a failed repair is reported; a provider applying a lost edit after that is named as accepted; AC4 narrowed to match

24. Joined chat and job requests have contradictory expiry rules.
    The same tool, input, agent and conversation can join one request, but a job deadline must close it while a parked chat request stays open. Exclude callers with incompatible lifetimes from joining, or define cancellation and expiry per caller. Extend AC6 with a joined chat/job ask whose job expires first.
   Disposition: keep amended: only chat asks join chat requests; a job run's request never joins or is joined; AC6 tests a chat and a job asking for the same action

## Round 4

No findings.

## Round 5

25. Disputed keep 5: Unproven: item 1: intake commits, but the host crashes before marking the inbox event done.
    The new idempotent approach can work, but AC1 stops at crashes before intake. Add a fault case that commits intake, consumes the message, then crashes before inbox completion; replay must preserve the consumed record and create no second input.
   Disposition: keep amended: AC1 adds a crash after intake consumed the message but before the inbox event is marked done

26. Durable queued replies have no defined relationship to turn recovery.
    [One message, one turn](docs/specs/one-message-one-turn.md) releases input when a turn fails before replying. If its reply already exists in the outbox but has not been sent, recovery can generate another reply while the original remains deliverable. Both can then arrive without any uncertain provider call. Pin how recovery reuses or cancels the original queued output, and add this crash case to AC4 or AC7.
   Disposition: keep amended: queuing a turn's first reply commits its input in the same transaction (One message, one turn's commit-before-send); AC4 adds the failed-after-queue case

## Round 6

No findings.
