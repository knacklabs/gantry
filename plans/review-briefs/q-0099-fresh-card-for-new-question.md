# Review brief — lite window Q-0099 (a new question on a stale card message becomes a fresh message)

Facts (live, 2026-08-26 14:47Z): a run raised a new permission question; the projection chose `edit` because a provider message existed, so the buttons were edited onto card message 9525 (first sent 2026-08-24). Providers do not notify on edits; the owner never saw the buttons and the run died waiting.

Contract for this diff (provider-neutral, projection only):
- `reviseLivingCard` promotes `edit` → `replace` only when a row with a (needId, askingEpoch) pair absent from the last revision appears AND the current provider message was confirmed more than 10 minutes ago (missing confirmation = stale).
- Button/scope/paging-only changes on an old message stay `edit`; new questions on a fresh message stay `edit`.
- `replace` is the existing path: retire notice on the old message + new message, on every provider.

BY DESIGN: 10 minutes is a constant, not configuration. Focus: the predicate cannot fire on retire/send/replace; no double-replace loops (a replace confirms a new message, resetting staleness). Ignore style.

Rounds: R1 paging novelty + edit-time staleness + test token — accepted; R2 lastDelivered too broad — accepted (replacePending); R3 replacePending only last revision — accepted (any undelivered replace); R4 message age from edit confirmations — accepted (send/replace delivery only); R5 "paging misclassified as new question" — REJECTED BY DESIGN: last.representedNeeds is built from ALL rows (rows.map), not the visible page, so paged-in pre-existing needs are already represented.
