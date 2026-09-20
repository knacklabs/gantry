# Slack reconnect replay

Slack Socket Mode can omit events while Gantry is disconnected. On every
connect or reconnect, Gantry recovers eligible messages for active conversation
installs before advancing a durable per-account, per-conversation cursor.

## Contract

- Recovery starts at the stored cursor, or the later of the install creation
  time and 24 hours before reconnect.
- The reconnect time is the fixed high-water mark for that pass.
- Channel history and qualifying thread replies are paginated, deduplicated,
  sorted chronologically, and processed in batches of at most 500.
- Recovered messages use the normal Slack normalization and ingress path. The
  canonical external-message and live-admission constraints fence live/replay
  races.
- Existing trigger, sender, install, and approver rules decide whether a message
  creates work. Bot and system messages remain ineligible.
- The cursor advances only after a batch is persisted, admitted, or rejected by
  those rules. Compare-and-swap prevents a stale worker from moving it backward.
- Failures leave the cursor unchanged. Rate limits honor `Retry-After`; other
  failures retry while connected with capped exponential backoff from five
  seconds to five minutes.

Runtime audit events are `channel.replay.started`,
`channel.replay.completed`, and `channel.replay.failed`. They contain only
account/conversation identifiers, time bounds, and counts.
