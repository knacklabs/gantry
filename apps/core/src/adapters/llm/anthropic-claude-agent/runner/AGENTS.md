# Anthropic Runner Notes

- Runtime continuation input, close sentinels, and interaction-boundary files
  should wake the live query through `RuntimeSignalPump`. Keep the fallback
  timer as missed-event recovery only; do not reintroduce primary sleep/poll
  loops for active live-turn signals.
- Filesystem wake events are not authority. The existing drain, permission,
  session, and SDK query code still decides what each file means and whether it
  can affect the provider stream.
- Live schema-constrained SDK results carry visible content, so emit a separate
  empty success frame as the host turn-complete marker. Preserve
  `continuedByFollowup` on that marker; otherwise the host leaves the valid
  structured result buffered while the persistent query waits for more input.
- After a live SDK result, keep the message stream open only when caller input
  is already buffered for the next turn. Otherwise close the stream so the
  runner exits and the host can publish `run.completed` for SDK consumers.
- An opt-in delegated completion gate is caller input at the same result
  boundary: request its decision before closing, buffer an approved
  continuation through `SteeringDeliveryGate`, and close normally only after
  the caller accepts completion.
