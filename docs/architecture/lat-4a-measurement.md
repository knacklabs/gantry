# LAT-4A Inbound Envelope Measurement

Decision 0082 removes one duplicate `ensureConversation` from each converted
paired metadata-and-message ingress. The measured reduction is uniform even
though provider totals differ.

## Statement counts

| Provider path  |       Before |        After |        Saved | Status                                                                                                                                                                              |
| -------------- | -----------: | -----------: | -----------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram text  |           28 |           19 |            9 | Converted and measured on real Postgres                                                                                                                                             |
| Slack          |           29 |           20 |            9 | Converted and measured on real Postgres                                                                                                                                             |
| Teams          |           28 |           19 |            9 | Converted and measured on real Postgres                                                                                                                                             |
| Discord        | Not measured | Not measured | Not measured | Converted, adapter-unit covered. No callable ingress seam to drive from an integration test, so the number is genuinely unmeasured rather than pending a rerun. Deferred as D-0026. |
| Telegram media |           22 |           22 |            0 | Reverted and deferred as D-0025                                                                                                                                                     |

For every converted provider that has a completed before/after measurement, the
delta is exactly **-9 statements**. Those nine statements are the duplicate
`ensureConversation`; no upserts inside the surviving call were removed.

Telegram media is deliberately not counted as converted. Its fused run invoked
`ensureConversation` once and issued 13 statements but left no conversation
row. The conversion was reverted, its supported result remains 22 statements,
and root-cause work is deferred as D-0025.

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
