---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-30
---

# LAT-5A Client Signoff

## Context

The client authorized the remaining response-latency program and on 2026-07-29
prioritised Phase 5 ahead of 4B, 6, 7 and 9 as the biggest remaining win. On
2026-07-30 they confirmed four delivery choices for it:

1. two PRs, the hydration-port change first and the durable coverage record
   second;
2. Discord and Teams record the weaker request-bounded coverage claim,
   explicitly labelled, rather than being excluded or treated as Slack;
3. a new dedicated `conversation_history_coverage` table rather than columns on
   `conversations` and `conversation_threads`;
4. the 2.5s hydration deadline is out of scope and unchanged.

Signal `S-0001-11ca` was raised and resolved before planning. The defect
reproduces for Slack, Discord and supported Teams, but the goal prompt's
"2.5s every turn" is a maximum wait on an unsettled promise rather than a
per-turn cost, and Telegram has no defect at all. The evidence and the resulting
contract are in
`docs/decisions/0087-lat-5-durable-provider-history-coverage.md`.

## Decision

Proceed with **LAT-5A**: widen `ConversationContextHydrationResult` so each
adapter reports what the provider actually returned — the requested boundary, the
window returned, any provider completeness signal, and the thread-root outcome —
with **no behaviour change and no schema change**.

LAT-5A does not add the durable record, the migration, the claim, or the
generation; those are LAT-5B. It does not change `CHANNEL_CONTEXT_LIMIT` or the
thread limits, the 2.5s deadline, Telegram or other hookless adapters, or the
memory/session hydration paths.

## Consequences

LAT-5A is the enabling change for the roadmap's rule that provider coverage be
recorded as actual coverage rather than inferred from local row count — today no
adapter can report it, so without this the rule cannot be satisfied.

Because LAT-5A changes no behaviour, its acceptance is that each adapter reports
coverage matching what the provider actually returned, that Slack's
server-confirmed signal is distinguishable in the type system from the weaker
request-bounded claim, and that existing hydration behaviour is byte-identical.

The task is not PR-ready until automated tests, deterministic verify, one
branch-closeout three-lens autoreview, and CI are green. Merging stays human
gated. LAT-5B does not start until LAT-5A is merged.
