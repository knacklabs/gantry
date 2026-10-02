---
slug: one-messaging-pipeline
title: One messaging pipeline for every provider
status: draft
saved: 2026-10-02T03:57:39+00:00
---

# One messaging pipeline for every provider

## Why

People talk to agents on Slack, Discord and Telegram today, through the web SDK, and soon on WhatsApp and Teams. A message must reach the agent once, in order, and the agent's reply, card or question must reach exactly the right place. Today each provider does this its own way, so the same bugs come back on every provider, and each new provider would bring them again.

**What the code shows (code map, 2026-10-02):**
- **Messages can be lost before they are saved.**
  - Slack acknowledges an event before Gantry processes it.
  - Discord handles gateway events without waiting for the result, and drops any failure.
  - Telegram moves on to the next update even when handling failed, and holds photos in an in-memory queue before saving them.
  - On every provider, lookups (thread parent, user names, attachment downloads) happen before the message is saved, so a failed lookup loses the message.
  - Slack and Discord fall back to marking history "untrusted" and re-reading it on the next turn. Telegram bots can't read history, so a lost Telegram message is gone for good.
- **Messages can be saved out of order.** All providers save through one in-memory queue that runs 4 at a time, so two messages from one chat can be saved in either order. An "overloaded" result is ignored.
- **Not every outgoing message is durable.**
  - The runner's `send_message` tells the agent "Message sent" before anything is sent, and if sending fails the message is filed away, never retried.
  - Rich cards are sent best-effort.
  - Streaming state is in memory.
  - Rate limits are only handled after a provider has refused.
- **Running on two hosts isn't safe yet.** The per-chat turn queue, timers, waiting prompts, stream state and progress state are held in one process's memory or files. The runner talks to the host through local files. Slack attachments are downloaded to local disk.
- **Approvals can only be answered in the chat that asked.** There's no way for a WhatsApp customer's request to be approved by a back-office team on Slack or Teams.
- **Teams is a non-working shell.** Its client returns nothing. WhatsApp doesn't exist yet (WA-1).

**What review found:** one external review on 2026-10-01 found 10 messaging bugs across providers, each fixed separately:
- a thread follow-up that skipped the sender allowlist;
- one agent behind two accounts in the same chat;
- two threads cutting off each other's streams;
- Slack thread replies;
- Telegram mentions;
- an overload that went silent;
- `send_message` reporting success early;
- Telegram photos for a chat bound to a shared bot's second account;
- Discord thread messages dropped when the parent lookup failed;
- ordering that didn't match the spec.

They share the causes above.

## Behaviour

**One pipeline, three durable lists.** Every provider feeds the same pipeline. Postgres holds the truth; process memory may only cache what can be rebuilt.

```
 provider edge ─▶ INBOX ─▶ unpack ─▶ INTAKE ─▶ TURN ─▶ OUTBOX ─▶ provider edge
```

- **Inbox.** Every incoming event (a message, an edit, a delete, a button tap) is saved before anything else happens. Only then does the edge acknowledge it to the provider.
  - **What is saved:** the inbound connection it arrived on, the event kind, the provider's id for the event, the raw channel and thread, the time it was received, and the raw payload.
  - **Duplicates.** One inbound connection can serve several bot accounts that share credentials. An event is a duplicate when its connection, kind and provider id match one already saved. Examples: Slack's event id, Telegram's update id, and Discord's message id plus the edit time for an edit. A duplicate is ignored. Fanning one event out to every account route that should get it happens in unpack, and each route gets its own copy of the message.
  - **When saving fails.** If saving fails (for example the database is down), the edge doesn't acknowledge, and the provider sends the event again:
    - Slack retries an unacknowledged event;
    - Telegram returns the update on the next poll, because the offset only moves past saved updates;
    - Discord replays events after the last sequence number that was saved, when the gateway resumes;
    - webhook providers get an error status and retry.
  - **When the provider has given up.** An event the provider stops retrying is outside this guarantee. Examples: Slack after its retries run out, or Discord when the session can't be resumed. The gap is logged. On Slack and Discord the conversation's history is marked untrusted, so the next turn re-reads it, as today.
- **Unpack.** A shared worker turns each saved event into Gantry's message. It does all the lookups that fail today (thread parent, sender, attachments), retrying with growing gaps.
  - **One transaction.** Saving the message, adding it to intake and marking the inbox event done happen in one database transaction. A crash leaves either all of it or none of it, and none means the event is unpacked again.
  - **Order.** Events from one raw channel and thread are unpacked in the order they were received; different threads and channels are unpacked in parallel.
  - **Stuck events.** An event still failing after its retries, which take at most 2 minutes, is set aside with a plain reason. Later events in that thread go on without it. A set-aside event that the admin retries and that then succeeds goes to intake as a late message: One message, one turn already gives a late message to the current turn or the next one.
  - **Commands skip the line.** Session commands such as /stop, and button taps, never wait behind another event in their thread. The codec recognises them from the raw event without any lookup.
  - **/stop covers what came before it.** A /stop applies to every event in its thread that was received before it, including events still being unpacked or set aside. When such an event reaches intake later, it is kept as history and never starts a turn.
- **Edits and deletes.**
  - **An edit** before its message is taken into a turn replaces the saved text. After that, the edit is kept in history and does not start a turn by itself.
  - **A delete** before its message is taken in removes it from intake. After that, the message is marked deleted in history.
  - **A target still in the inbox.** An edit or delete whose message is still being unpacked or is set aside is applied when that message is unpacked. A deleted message is never delivered, and an edited one is delivered with its edited text, even when the admin retries it.
  - **A missing target.** An edit or delete whose message is in neither the inbox nor history is logged and ignored.
- **Intake.** One record per conversation of which messages the agent has taken in (from the One message, one turn story).
  - Which messages are taken, and in what batches, follows Gantry's receive order, never a provider's clock.
  - How a batch is shown to the agent stays as One message, one turn defines it.
  - Intake still decides whether a message starts a turn: mention rules, the sender allowlist, the busy limit and /stop are unchanged. The guarantee here is that every saved message reaches intake exactly once.
- **Outbox.** Everything that leaves goes through one durable outbox: replies, edits, streams, cards, questions, `send_message`, and notices. Each item is retried until the provider confirms it or it is reported failed.
  - **The agent's result.** For `send_message`, the agent is told "delivered" only after the provider confirms, and "failed" with the reason otherwise.
  - **Sends that may repeat.** Sometimes nobody can know whether the provider got a send:
    - the host died after calling the provider but before recording the receipt;
    - the call timed out;
    - the connection dropped after the request went out.

    The item is then sent once more and never again. This is the one accepted case where a person may see a message twice.
    - Where a provider can reject a repeat, the outbox uses that, and resends within the provider's window. Discord, for example, rejects a repeat that carries the same nonce with `enforce_nonce` set, for a few minutes.
    - Edits and stream updates are always safe to repeat.
  - A stream is one outbox item that keeps only its newest text and is sent at the provider's edit pace, so edits never pile up or collide.
    - **One edit at a time.** Each stream has at most one edit in flight. The next edit is sent only after the previous one is confirmed or has definitely failed, so Gantry never reorders its own edits.
    - **An edit with an uncertain result.** If an edit's result is uncertain, the outbox waits past the provider's timeout and then sends the newest text once more. If that repair fails, the stream is reported failed and logged.
    - **The rare case Gantry can't control.** A provider can still apply a lost edit after the repair. That would leave older text showing, and it is accepted as the provider's behaviour.
  - Each bot account has one send-rate budget shared by all workers, so Gantry slows itself down before a provider blocks it.
  - Typing indicators and reactions stay best-effort; they are not queued.

**A provider is two small parts.**
- **Edge:** connect, receive, acknowledge, and call the provider's send, edit and delete APIs.
- **Codec:** turn the provider's event into Gantry's message, and Gantry's reply into the provider's format.

Everything else is shared and written once: ordering, retries, de-duplication, the busy notice, permission prompts, streaming and rate limits.

Each provider declares what it can do: edit messages, buttons and how many, threads, text length limit, typing, and reply windows such as WhatsApp's 24 hours. The shared core adapts to the declaration:
- **No editing:** send only the final answer. A message that would have been updated in place, such as "Checking with the team", is followed by a new message with the outcome.
- **No threads:** each approval card stands alone and names the requester conversation in its text.
- **No buttons:** the card says "Reply 1, 2 or 3 to request K7". Each request has a short code, and an answer counts only when it names the code.
- **A closed reply window:** the outbox sends the provider's approved template message, which the admin picks when setting up the provider.
  - Setting up a provider with a reply window requires choosing that template.
  - If the template send fails, the outcome is kept, and the admin sees it in the failed-items list.

Adding WhatsApp or finishing Teams means writing an edge, a codec and its declaration. The shared core needs no changes.

**The host chooses every address; the agent never does.**
- An address is a provider, bot account, chat and thread.
- When a turn starts, the host gives it a set of addresses:
  - its reply address, which is the conversation it serves;
  - the agent's approval address, used only for the host's own approval cards;
  - addresses the permission gate has allowed for this turn. A tool call such as "post the summary to #team" is decided like any other call: Allow once adds the address for this turn, and Allow for future saves it for that agent and conversation.
- The agent and its instructions name a purpose ("post to #team"); the host turns the purpose into an address.
- The outbox refuses, and logs, any item whose address isn't in its turn's set. An approval card is accepted only at the approval address, and agent output only at the reply address or an address the gate allowed. A turn serving one customer can never send to another customer's chat.

**Approvals can be answered from another chat.**
- Each agent has one approval address. By default it is the same chat, as today. An admin can point it at a back-office chat on any provider, such as a Slack or Teams channel.
  - Owner choice, 2026-10-02: one approval address per agent; per-capability routing can come later.
- **Who may answer:** the people who have the approver role in the chat at the approval address. This uses the existing approver roles there, and it is checked at the moment of the tap, so a role removed while a request waits takes effect at once.
  - With no approval address set, the requester conversation's own approvers answer, as today.
  - An approval address whose chat has no approvers is refused when the admin sets it.
  - Owner choice, 2026-10-02: "that chat's approvers".
- **An approval is one saved record linking two addresses.** It holds:
  - who asked (the requester's address, agent and conversation);
  - where the question went;
  - the waiting action: the tool and its exact input, with secrets hidden in what is shown;
  - what is asked (secrets hidden) and why;
  - its state: waiting, answered, expired or cancelled;
  - who answered.
- **The requester's side.**
  - **One message.** The requester gets one message ("Checking with the team, I'll come back to you") that is updated in place.
  - **Waiting live.** The turn waits for the answer as a chat turn waits today (decision 0053).
  - **Parking.** If it is still waiting when the turn has to end (its wait limit, or a restart), the turn ends and the request stays open. A wait of hours or days holds no process.
  - **A late answer.** It starts a new turn in the requester's conversation, in the same agent session. That turn is told the outcome. If the answer was Allow once, the same action is allowed once in that turn, and the agent carries on from there.
    - **One transaction.** Recording the answer and adding the new turn's work to intake happen in one transaction, keyed by the request, so a crash can neither lose the new turn nor create it twice.
  - **Requests from scheduled jobs.** These keep the job rules of Scheduled jobs and chat share one permission flow: the request closes at the job's deadline (its next scheduled time, or 24 hours), a late tap on it applies nothing, and the next run asks again. The job keeps its own working session. Only where the card goes changes: it goes to the approval address.
  - **A closed reply window.** If the provider's reply window has closed by then, the outbox uses the provider's template.
- **The approver's side.**
  - **One card per request.** In the back office, a card names the customer conversation, the agent, the action and the reason. Cards for one requester conversation stay together in one thread where the provider has threads.
  - **The first valid tap wins.** An answer and a cancel each change the request's state with one conditional update, so whichever lands first wins. Other copies of the card update to say who answered.
  - **Unauthorised taps.** A tap by someone who isn't an approver there is refused and logged.
  - **Typed answers.** A typed answer counts only as a direct reply to the card, or with the request code where there are no buttons. Gantry never guesses "the latest pending request".
- **Ending and repeats.**
  - **Ended requests.** /stop, expiry or a closed conversation cancels the request and updates the card to "No longer needed".
  - **Answered before /stop.** If the answer won first, its new turn is queued work, and /stop cancels it like any other waiting work.
  - **Repeated asks.** In a chat, asking again for the same tool with the same input, by the same agent in the same conversation, while a chat request is waiting, joins that request without sending a second card. A scheduled job's run never joins another request and no other caller joins it, because its request has its own deadline. The one answer applies to every caller that joined. An Allow for future saves the approval at its normal breadth (a capability or program), as the permission spec defines.
  - **An unreachable approval address.** The outbox retries. After a deadline, the requester is told it couldn't be approved yet, and the admin sees why.
- **Where approvals apply and what flows back.**
  - **Scope of "Allow for future".** It applies to the requester's agent and conversation (the scope from Scheduled jobs and chat share one permission flow), never to the back-office chat.
  - **No back-office talk reaches the requester.** Only the outcome does, worded by the agent in the requester's turn.
- **Button taps are inbox events** carrying the request id. A tap resolves the same way whichever host or provider receives it, and a crash after the tap is saved resolves it on restart.

**Many hosts.**
- **Per-chat order, all chats in parallel.** One worker at a time holds a conversation, and a worker skips conversations another worker holds. Adding workers adds capacity.
- **Connections.** Each always-on connection (Telegram polling, the Discord gateway, Slack Socket Mode) has one leased owner, and another host takes over if the owner dies. The connection's checkpoint (Telegram's offset, Discord's session and sequence number) is saved in Postgres, so the new owner carries on from it. Webhook providers (WhatsApp, Teams, the web SDK) can land on any host.
- **A returning old owner is refused.** Conversation leases, connection leases and outbox claims carry a fencing number, from the existing worker-coordination leases. A host that was paused or cut off and comes back after another host took over has its writes refused, and it stops.
- **Files.** Files go to object storage, not a host's disk.
- **Host and runner.** The host and its runners talk through the database or an authenticated channel, not shared local folders.

**Records stay bounded.**
- Inbox events are deleted 30 days after they are unpacked. That is longer than any provider's redelivery window, so duplicates are still recognised for as long as they can arrive.
- A set-aside event is kept until the admin retries or dismisses it, or for 30 days, and then deleted with a log line.
- Outbox items and ended approvals are kept 30 days, as the permission spec keeps its history.
- Files in object storage live as long as the message that holds them. Anything a waiting request, an unconsumed message or an outbox item still uses is never deleted.

**Tracing.**
- One trace id follows an event from inbox to turn to outbox, so "where did my message go?" has one answer.
- The admin can list events that were set aside and outbox items that failed, with their reasons.

**Decisions this changes**
- **Scheduled jobs and chat share one permission flow** (one-permission-flow) says a prompt "never asks somewhere else". That is amended: a prompt goes to the agent's approval address, which is the same chat unless an admin sets another.
- **0110:** typing and reactions stay best-effort.
- **0049:** an overloaded backlog keeps its busy notice. The notice goes out through the outbox.
- **WA-1 and TEAMS-1** are re-scoped as an edge and a codec on this pipeline.

## Risks

- **One-way: set-aside messages are deleted after 30 days.** A message that never unpacked and wasn't retried or dismissed by then is lost for good. The admin sees each set-aside event in the failed-items list for those 30 days. A retention test proves that nothing waiting or still referenced is deleted.

- **One-way: new tables and migrations.**
  - The inbox and approval records are new tables.
  - Moving in-memory queues and state into Postgres changes how a running system restarts.
  - Each story migrates in one step with no dual reads, so a bad migration needs a fix forward.
- **Every message now gets a write before it's acknowledged.** The added latency is a few milliseconds per event. Slack's and Teams' 3-second acknowledge limit leaves a wide margin.
- **Approvals from another chat widen who sees a request.**
  - Back-office approvers see the action, the reason and the customer's conversation name. Secrets stay hidden.
  - An admin chooses the approval address; the agent can't.
- **Postgres is the queue.** It handles thousands of events a second this way. A dedicated message broker would only be needed well beyond that, and would not change the pipeline's stages.

## Acceptance criteria

- **AC1. Every saved event reaches intake exactly once.** For each provider, an event still reaches intake once in each of these cases:
  - a lookup fails and later succeeds;
  - saving to the inbox fails and the provider resends;
  - the host crashes between saving and unpacking;
  - the host crashes between unpacking and intake.

  Intake's normal rules then decide whether it starts a turn. An event that keeps failing is listed as set aside, with its reason, and later events in its thread go on without it.
- **AC2. A redelivered event is unpacked once,** including when one connection serves two accounts and the event fans out to both routes.
- **AC3. Messages from one chat are taken into turns in the order Gantry received them.** This holds for quick bursts and photos, and when two workers are running. A /stop sent behind a stuck event is still handled at once, and that event, unpacked later, is kept as history. An edit or delete of a set-aside message still applies when it is retried.
- **AC4. Every outgoing item goes through the outbox and is retried until it is confirmed or reported failed.** This covers replies, streams, cards, questions and `send_message`.
  - `send_message` tells the agent the real result.
  - After a crash, a timeout or a dropped connection with an uncertain result, the item is sent at most once more.
  - A stream sends one edit at a time, and an edit with an uncertain result is followed by one repair with the newest text.
- **AC5. Items outside their turn's address set are refused and logged.** An agent's attempt to reach another conversation sends nothing there. The same send succeeds after the permission gate allows that address. An approval card is accepted only at the approval address.
- **AC6. A request from one provider's chat can be approved from another.** A test covers a requester on one provider and an approval address on another, including:
  - a wait across a host restart, then a late answer that starts a turn which carries on with the allowed action;
  - two approvers tapping at once;
  - a tap by someone who isn't an approver, and an approver whose role is removed while the request waits;
  - /stop while waiting, and /stop racing an answer;
  - a repeated chat ask joining the waiting request, while a job's ask for the same action gets its own request and expires on its own deadline;
  - a crash right after the answer is recorded, which still starts exactly one new turn;
  - a scheduled job's request that reaches its deadline and closes;
  - a provider without buttons, answered with the request code.
- **AC7. Two hosts run together with nothing lost, doubled or reordered.** This holds when a host dies holding a connection or a conversation, and when a paused host comes back after another took over: the returning host's writes are refused.
- **AC8. A new provider needs only an edge, a codec and a capability declaration.** The WhatsApp provider (WA-1) is built this way, with no changes to the shared core.

## Success measure

- Metric: messaging defects per month, counted from merged fixes whose cause is a message lost, doubled, out of order or sent to the wrong place, on any provider.
- Baseline: 10 such defects found in one review on 2026-10-01.
- Target: 2 or fewer a month in the two full months after MSG-4 merges. AC7 is also proven by its two-host test.
- Check date: 2027-02-01

## Slices

- **MSG-1 — saved before anything can fail.** The inbox, the shared unpack worker, and ordering by receive counter. Slack, Discord and Telegram move onto it, and their pre-save lookups and in-memory save queues are deleted.
- **MSG-2 — one outbox, host-chosen addresses.**
  - `send_message` reports the real result.
  - Cards and streams go through the outbox.
  - Each bot account gets one send-rate budget.
  - Each turn's address set is checked.
- **MSG-3 — approvals from another chat.** The approval address per agent, the approval record, parked turns, and button taps through the inbox. Comes after PERMFLOW-3.
- **MSG-4 — several hosts.**
  - The per-chat queue moves to database leases.
  - Every connection is leased.
  - Files go to object storage.
  - The host and runner stop sharing local folders.
- **Then the existing WA-1 (WhatsApp) and TEAMS-1 (Teams)** are each built as an edge and a codec.

## Roadmap

- MSG-1: Every incoming message is saved before anything can fail
- MSG-2: Everything the agent sends goes through one outbox, only to addresses the host chose
- MSG-3: Approvals can be answered from another chat
- MSG-4: Several hosts run with nothing in memory that matters
