---
slug: lat-5b-durable-history-coverage
title: Durable provider-history coverage
status: confirmed
saved: 2026-07-31T15:11:43+00:00
---

# Durable Provider-History Coverage

## Capability

The runtime durably remembers, per conversation and scope (channel or
thread), whether the messaging provider has CONFIRMED that all history has
been fetched — and uses that memory so fully-covered conversations never
repeat the provider history request or its up-to-2.5-second wait.

## Contract (implementation-neutral)

1. Completeness may be recorded ONLY from a provider-confirmed exhausted
   claim under the canonical aggregate coverage protocol (decision 0089);
   request-bounded claims can never be promoted to complete, by
   construction.
2. Recorded completeness is trustworthy only while live delivery has been
   gapless since recording: any (re)connect or stream reset for the
   provider account invalidates it fail-safe — the next turn re-verifies
   with at most one extra hydration, and a missed message is impossible to
   silently paper over. Invalidation fires at EVERY seam where delivery can
   gap, per the independent plan critique: before the awaited inbound
   connect begins (events can arrive during the await), fanned across every
   provider account sharing one transport; on every gateway reconnect entry
   (socket close and provider resume/re-identify opcodes); and on
   library-managed reconnects below the provider SDK's start call — which
   requires an explicit adapter lifecycle signal where the SDK owns
   reconnection silently (Slack Socket Mode). Providers without a real
   client (Teams today) get fake-adapter proof only, stated as such.
3. A turn in a covered conversation makes zero provider history calls and
   never enters the hydration deadline wait; behaviour for uncovered
   conversations is byte-identical to today.
4. Attestation writes are idempotent and safe under concurrency; stale
   writers no-op.
5. Providers without a history hook get no coverage state (nothing to skip).

## Provenance

Grilled premise and shape: decisions 0087 (accepted; the two-PR split, the
corrected 2.5s-is-a-ceiling framing) and 0088 (client sign-off). Coverage
honesty prerequisites shipped in LAT-5A (#355) and GH-352 (#359).
