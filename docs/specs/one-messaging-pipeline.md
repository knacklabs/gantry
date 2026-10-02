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

- **Inbox.** Every incoming event (a message, an edit, a delete, a button tap) is saved before anything else happens: who it came from (provider, bot account), the raw channel, the provider's own event id, and the raw payload. Only then is the provider told "received". A redelivered event is recognised by the provider's id and ignored.
- **Unpack.** A shared worker turns each saved event into Gantry's message. It does all the lookups that fail today (thread parent, sender, attachments), retrying with growing gaps. Events from one raw channel are unpacked in the order they were received; different channels are unpacked in parallel. An event that still fails after its retries is set aside with a plain reason that the admin can see. It is never silently dropped.
- **Intake.** One record per conversation of which messages the agent has taken in (from the One message, one turn story). Order within a conversation comes from Gantry's own receive counter, never a provider's clock.
- **Outbox.** Everything that leaves goes through one durable outbox: replies, edits, streams, cards, questions, `send_message`, and notices. Each item is sent with retries and records the provider's receipt. The agent is told the real result.
  - A stream is one outbox item that keeps only its newest text and is sent at the provider's edit pace, so edits never pile up or collide.
  - Each bot account has one send-rate budget shared by all workers, so Gantry slows itself down before a provider blocks it.
  - Typing indicators and reactions stay best-effort; they are not queued.

**A provider is two small parts.**
- **Edge:** connect, receive, acknowledge, and call the provider's send, edit and delete APIs.
- **Codec:** turn the provider's event into Gantry's message, and Gantry's reply into the provider's format.

Everything else is shared and written once: ordering, retries, de-duplication, the busy notice, permission prompts, streaming and rate limits.

Each provider declares what it can do: edit messages, buttons and how many, threads, text length limit, typing, and reply windows such as WhatsApp's 24 hours. The shared core adapts to the declaration:
- no editing: send only the final answer;
- no buttons: show "reply 1, 2 or 3";
- a closed reply window: use the provider's approved template message.

Adding WhatsApp or finishing Teams means writing an edge and a codec, nothing else.

**The host chooses every address; the agent never does.**
- An address is a provider, bot account, chat and thread.
- When a turn starts, the host gives it a fixed set of addresses:
  - its reply address, which is the conversation it serves;
  - the policy addresses set by an admin, such as the agent's approval address.
- The agent and its instructions name a purpose ("ask for approval", "post to the back office"); the host turns the purpose into an address.
- The outbox refuses, and logs, any item whose address isn't in its turn's set. A turn serving one customer can never send to another customer's chat.
- Sending to another chat on purpose is a tool call, decided by the permission gate like any other.

**Approvals can be answered from another chat.**
- Each agent has one approval address. By default it is the same chat, as today. An admin can point it at a back-office chat on any provider, such as a Slack or Teams channel.
  - Owner choice, 2026-10-02: one approval address per agent; per-capability routing can come later.
- An approval is one saved record linking two addresses. It holds:
  - who asked (the requester's address, agent and conversation);
  - where the question went;
  - what is asked (secrets hidden) and why;
  - its state: waiting, answered, expired or cancelled;
  - who answered.
- **The requester's side.** The requester gets one message ("Checking with the team, I'll come back to you") that is updated in place.
  - The waiting turn is parked, not running, so a wait of hours or days holds no process and survives restarts.
  - The answer starts a turn in the requester's conversation with the result. If the provider's reply window has closed by then, the outbox uses the provider's template.
- **The approver's side.**
  - **One card per request.** In the back office, a card names the customer conversation, the agent, the action and the reason. Cards for one requester conversation stay together in one thread.
  - **The first valid tap wins, in one database update.** Other copies of the card update to say who answered.
  - **Unauthorised taps.** A tap by someone who isn't an approver is refused and logged.
  - **Typed answers.** A typed "yes" counts only as a direct reply to the card. Gantry never guesses "the latest pending request".
- **Ending and repeats.**
  - **Ended requests.** /stop, expiry or a closed conversation updates the card to "No longer needed". No result is delivered after that.
  - **Repeated asks.** Asking again for the same action while a request is waiting joins that request, without sending a second card.
  - **An unreachable approval address.** The outbox retries. After a deadline, the requester is told it couldn't be approved yet, and the admin sees why.
- **Where approvals apply and what flows back.**
  - **Scope of "Allow for future".** It applies to the requester's agent and conversation (the scope from Scheduled jobs and chat share one permission flow), never to the back-office chat.
  - **No back-office talk reaches the requester.** Only the outcome does, worded by the agent in the requester's turn.
- **Button taps are inbox events** carrying the request id. A tap resolves the same way whichever host or provider receives it.

**Many hosts.**
- **Per-chat order, all chats in parallel.** One worker at a time holds a conversation, and a worker skips conversations another worker holds. Adding workers adds capacity.
- **Connections.** Each always-on connection (Telegram polling, the Discord gateway, Slack Socket Mode) has one leased owner, and another host takes over if the owner dies. Webhook providers (WhatsApp, Teams, the web SDK) can land on any host.
- **Files.** Files go to object storage, not a host's disk.
- **Host and runner.** The host and its runners talk through the database or an authenticated channel, not shared local folders.

**Tracing.**
- One trace id follows an event from inbox to turn to outbox, so "where did my message go?" has one answer.
- The admin can list events that were set aside and outbox items that failed, with their reasons.

**Decisions this changes**
- **Scheduled jobs and chat share one permission flow** (one-permission-flow) says a prompt "never asks somewhere else". That is amended: a prompt goes to the agent's approval address, which is the same chat unless an admin sets another.
- **0110:** typing and reactions stay best-effort.
- **0049:** an overloaded backlog keeps its busy notice. The notice goes out through the outbox.
- **WA-1 and TEAMS-1** are re-scoped as an edge and a codec on this pipeline.

## Risks

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

- **AC1. Nothing is lost after the provider hands over an event.** For each provider, when an event arrives and a lookup then fails, or the host restarts before the message is unpacked, the agent still gets the message once, after the lookup succeeds. An event that keeps failing is listed as set aside, with its reason.
- **AC2. A redelivered event is answered once.**
- **AC3. Messages from one chat reach the agent in the order received.** This holds for quick bursts and photos, and when two workers are running.
- **AC4. Every outgoing item goes through the outbox and is retried until it is delivered or reported failed.** This covers replies, streams, cards, questions and `send_message`. The agent is told the real result of `send_message`.
- **AC5. An item addressed outside its turn's address set is refused and logged.** A test in which the agent tries to reach another conversation proves nothing is sent there.
- **AC6. A request from one provider's chat can be approved from another.** A test covers a requester on one provider and an approval address on another, including:
  - a wait across a host restart;
  - two approvers tapping at once;
  - an unauthorised tap;
  - /stop while waiting;
  - a repeated ask joining the waiting request.
- **AC7. Two hosts run together with nothing lost, doubled or reordered.** This holds when a host dies holding a connection or a conversation.
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
