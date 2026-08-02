# LAT-4A Inbound Envelope Measurement

Decision 0085 removes one duplicate `ensureConversation` from each converted
paired metadata-and-message ingress. The measured reduction is uniform even
though provider totals differ.

## Statement counts

| Provider path  |       Before |        After |        Saved | Status                                                                                                                                                                              |
| -------------- | -----------: | -----------: | -----------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram text  |           28 |           19 |            9 | Converted and measured on real Postgres                                                                                                                                             |
| Slack          |           29 |           20 |            9 | Converted and measured on real Postgres                                                                                                                                             |
| Teams          |           28 |           19 |            9 | Converted and measured on real Postgres                                                                                                                                             |
| Discord        | Not measured | Not measured | Not measured | Converted, adapter-unit covered. No callable ingress seam to drive from an integration test, so the number is genuinely unmeasured rather than pending a rerun. Deferred as D-0028. |
| Telegram media |           22 |           22 |            0 | Reverted and deferred as D-0027                                                                                                                                                     |

For every converted provider that has a completed before/after measurement, the
delta is exactly **-9 statements**. Those nine statements are the duplicate
`ensureConversation`; no upserts inside the surviving call were removed.

Telegram media is deliberately not counted as converted. Its fused run invoked
`ensureConversation` once and issued 13 statements but left no conversation
row. The conversion was reverted, its supported result remains 22 statements,
and root-cause work is deferred as D-0027.

Discord cannot be driven through its production ingress without a live gateway:
`DiscordChannel.connect` wires inbound delivery to a private WebSocket dispatch
handler, and `MESSAGE_CREATE` reaches the private message handler only through
that socket. Replacing the WebSocket and REST boundary would fake the transport,
so LAT-4A-3 covers the registered paired-message call shape at the Discord unit
adapter seam instead. No Discord Postgres statement count was observed or added
to the expectation table.

## What did NOT improve

- **Total database round trips are unchanged.** The statements for the message
  half were already batched inside one transaction. LAT-4A proves a statement
  reduction; it does not establish a round-trip reduction.
- **The transaction lock window grows.** Conversation-graph upserts that
  previously ran outside any transaction now run inside the message and
  admission transaction.
- **No end-to-end latency was measured.** These are deterministic SQL statement
  counts, not user-visible response-time measurements.

The gain demonstrated here is narrower: nine fewer SQL statements on every
measured converted ingress, while preserving conversation identity, standalone
metadata paths, multi-route admission, and notify-after-commit ordering.

## Multi-route is NOT covered

The roadmap scoped "all eligible admissions in one serialized transaction".
Delivered for single-route; NOT delivered for multi-route, where each route
still gets its own `storeMessageWithLiveAdmission` call that commits and
notifies independently. Branch autoreview caught this as a P1 against the
patch's own stated guarantee, and it is deferred as D-0029 rather than
implemented untested against the durable admission queue.

Anyone reading "one inbound envelope transaction" should read it as
"one per route", not "one per message", until D-0029 lands.


## LAT-4B — graph-write reduction (2026-08-02, measured)

LAT-4A's history above is unchanged. LAT-4B deleted the same-transaction
redundant identity writes (decision 0096 pins thread recency to the message
timestamp):

| Route | Before | After | Saved |
| --- | --- | --- | --- |
| Registered top-level envelope (Telegram text / Slack / Teams) | 19 | **15** | 4 (apps + llm_profiles at two call sites; startup seeds prove them) |
| Registered thread envelope (first pinned thread measurement) | 29 | **16** | 13 (the 8 nested identity/config repeats + the duplicate conversations write + the 4 above) |

Proofs live in `inbound-envelope-statements.postgres.integration.test.ts`
(exact-count pins per route, first-contact completeness for a brand-new
conversation + thread in one envelope, monotonic message-timestamp recency,
`isGroup` survival). What did not improve: the CONDITIONAL identity upserts
(providers/agents/config/accounts, ~7 statements) remain pending the
graph-ready receipt (D-0041); wall-clock latency is not measured — statement
counts are the contract.
