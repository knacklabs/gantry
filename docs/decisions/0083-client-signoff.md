---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-29
---

# LAT-4A Client Signoff

## Context

The client authorized the complete remaining MyClaw response-latency program on
2026-07-28 and on 2026-07-29 asked for all remaining tasks to be completed with
autoreview clean. LAT-4A is the roadmap's Phase 4A, "One Inbound Envelope
Transaction", on branch `perf/phase4a-inbound-envelope-persistence`.

The client required that each phase reproduce its baseline before changing
production behavior, and that a Forge signal be raised and the plan revised
rather than the implementation forced when the premise does not hold.

Signal `S-0001-f4d3` (contradiction) was raised and resolved before planning.
The two-phase inbound write reproduces at 28 SQL statements, but transaction
fusion alone saves zero statements and zero round trips. The measured win is
deleting the duplicated `ensureConversation` on the paired path by carrying
name and isGroup into the surviving call. Evidence and constraints are recorded
in `docs/decisions/0082-lat-4a-fused-inbound-envelope-transaction.md`.

## Decision

Proceed with LAT-4A under the sharpened scope in decision 0082: one transaction
for the paired inbound path, `ensureConversation` invoked once with name and
isGroup carried in, the paired metadata invocation deleted, admissions notified
after commit.

LAT-4A does NOT authorize touching the six standalone metadata paths that never
persist a message, collapsing the stable identity upserts inside
`ensureConversation`, or any settings, schema, public API, CLI, or permission
change.

## Consequences

This is a persistence change, so the disposable Postgres lane is required and a
missing `GANTRY_TEST_DATABASE_URL` is a blocker rather than a pass, per Program
Acceptance rule 6. The PR must report before/after statement counts from
identical deterministic scenarios and state explicitly what did not improve.

Acceptance must prove `conversations.title` and `conversations.kind` survive a
first group message, that every selected route keeps its admission identity and
trigger decision, and that admissions are notified only after commit.

The task is not PR-ready until automated tests, deterministic verify, one
branch-closeout three-lens autoreview, and CI are green. Merging stays human
gated. Phase 4B does not start until LAT-4A is merged.
