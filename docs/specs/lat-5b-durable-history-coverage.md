---
slug: lat-5b-durable-history-coverage
title: Durable provider-history coverage
status: confirmed
saved: 2026-07-31T15:35:00+00:00
---

# Durable Provider-History Coverage

## Capability

The runtime durably remembers, per conversation and scope (channel or
thread) within a provider account, whether the messaging provider has
CONFIRMED that all history has been fetched — and uses that memory so
fully-covered conversations never repeat the provider history request or
its up-to-2.5-second wait.

## Independent critique verdict

**VERDICT: BUILDABLE WITH REQUIRED EDITS.** The plan is safe to implement only
with all of the following requirements folded into the capability contract:

1. Key coverage and its delivery generation by provider account as well as
   conversation and scope, so one account's proof or reconnect cannot be
   mistaken for another's.
2. Advance that generation before every provider-specific connect, reconnect,
   or stream-reset seam can accept delivery; fence both coverage reads and
   attestation writes against it so a reconnect racing a turn cannot preserve
   or recreate stale completeness.
3. Fail closed when invalidation cannot be made effective: the covered fast
   path is forbidden until the account is known uncovered in the current
   generation.
4. Require explicit proof for every enumerated provider seam class, including
   transport fan-out and SDK-owned reconnects; a provider with no real client
   may supply fake-adapter contract proof only and must not imply live coverage.
5. Prove the optimization at both observable boundaries: a covered turn makes
   neither a provider-history call nor an entry into the hydration deadline
   wait, while an uncovered turn retains today's behavior.

## Contract (implementation-neutral)

1. Completeness may be recorded ONLY from a provider-confirmed exhausted
   claim under the canonical aggregate coverage protocol (decision 0089);
   request-bounded claims can never be promoted to complete, by
   construction.
2. Recorded completeness is trustworthy only while live delivery has been
   gapless since recording: any (re)connect or stream reset for the
   provider account invalidates it fail-safe — the next turn re-verifies
   with at most one extra hydration, and a missed message is impossible to
   silently paper over. Invalidation advances a provider-account delivery
   generation before the seam can accept events; coverage reads and writes
   must match the current generation, stale writers no-op, and failure to
   advance or invalidate forbids the covered fast path.
3. A turn in a covered conversation makes zero provider history calls and
   never enters the hydration deadline wait; behaviour for uncovered
   conversations is byte-identical to today.
4. Attestation writes are idempotent and safe under concurrency; stale
   writers no-op.
5. Providers without a history hook get no coverage state (nothing to skip).

## Reconnect invalidation seams

Every applicable row is part of the contract; covering only the common start
path is insufficient.

| Provider | Seam classes that must invalidate before delivery | Required proof |
| --- | --- | --- |
| Telegram | Initial awaited long-poll start and every poller restart or stream reset | Adapter test that advances the account generation before the awaited start/restart |
| Discord | Initial gateway connect, socket close, resume entry, and re-identify entry | Adapter tests for each gateway transition, including fan-out to every provider account sharing the transport |
| Slack Socket Mode | Initial awaited SDK start and every library-managed reconnect below that call | An explicit adapter lifecycle signal plus tests showing generation advance before start and SDK-owned reconnect delivery |
| Teams | No real client exists today | Fake-adapter contract proof only, labelled as non-live; a real client cannot ship without enumerating and proving its actual seams |

If a transport multiplexes provider accounts, one transport seam invalidates
every account on that transport. If a provider library reconnects silently,
the adapter must surface that lifecycle transition; polling cannot substitute
for the signal.

## Provenance

Grilled premise and shape: decisions 0087 (accepted; the two-PR split, the
corrected 2.5s-is-a-ceiling framing) and 0088 (client sign-off). Coverage
honesty prerequisites shipped in LAT-5A (#355) and GH-352 (#359).
