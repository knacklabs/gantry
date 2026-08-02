---
slug: lat-4b-graph-write-reduction
title: LAT-4B graph-write reduction
status: confirmed
saved: 2026-08-02T06:33:53+00:00
---

# LAT-4B — Graph-write reduction on the message hot path

## Capability

Message persistence stops re-asserting identities the same transaction (or
startup) already proved: a registered top-level envelope persists in 15 SQL
statements (from 19) and a thread envelope in 16 (from 29), with identical
durable outcomes. Thread activity orders the chat list by the message's own
timestamp, monotonically, exactly like top-level messages (decision 0096),
and thread messages no longer strip `isGroup` from the conversation's
external reference.

## Behaviour (acceptance)

1. Registered top-level envelope: exactly 15 statements, 1 transaction,
   pinned on real Postgres for Telegram text, Slack, and Teams routes.
2. Thread envelope: exactly 16 statements, 1 transaction — the first pinned
   thread measurement.
3. First contact still works entirely: a brand-new conversation AND a
   brand-new thread arriving in one envelope are fully created by the
   surviving statements (conversation, thread, participant, message, parts,
   admission).
4. A thread message with a timestamp older than the conversation's stored
   recency does not reorder the chat list; a newer one does; `isGroup`
   survives thread traffic.
5. The jobs path (`ensureAgentExists`) retains its explicit seed guard. The
   shared `ensureAgent` simplification preserves first creation plus name/config
   refresh for conversation, session, and binding/setup callers.
6. Both production `ensureThread` callers pass the exact conversation ID
   returned by their immediately preceding outer ensure; the stored thread is
   attached to that ID, with no derivation fallback.

## Non-goals

The provider/agent/account CONDITIONAL collapse (graph-ready receipt) —
deferred with a measured trigger. Wall-clock latency measurement. Any
LOAD-BEARING row (users, aliases, participants, messages, parts, admission).

## Constraints

No migration; no compensating SELECTs; `ensureApp` survives and
`ensureAgentExists` keeps its explicit jobs-path call. `ensureConversation` and
shared `ensureAgent` stop reasserting the startup-proven app/profile seeds.
`ensureThread` requires the caller's `conversationId`; there is no optional
legacy input, fallback graph ensure, helper, or overload. LAT-4A's historical
saved-statement constant remains 9; LAT-4B records separate savings of 4 for a
top-level envelope and 13 for a thread envelope.
