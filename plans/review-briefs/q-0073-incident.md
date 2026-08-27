# Review brief — lite window Q-0073 (JOBPERM-1 incident fix continuation)

Incident: a Telegram job-permission card was sent as a NEW message on every delivery revision (duplicate cards), buttons rendered as plain text, and copy was machine-like.

Contract for this diff:
- One Telegram card per job-permission request across ALL delivered revisions: first revision sends, later revisions EDIT the same message (by previous message id). Never a second send for the same card.
- Re-delivery of an already-delivered revision returns the recorded message id without any provider mutation (idempotent).
- A revision carrying job_permission_decision affordances renders a native inline keyboard; if those affordances cannot form a keyboard (malformed/mismatched tokens) delivery throws.
- BY DESIGN: `retire` and `replace` revisions carry ZERO affordances and edit the existing card into a buttonless notice through the generic replaceMessageId path (see job-permission-wiring-setup.ts / jobPermissionCardText). A zero-action delivery is not a card contract violation — do not report it.
- BY DESIGN: cross-restart idempotency is owned upstream by durable per-revision delivery outcomes (job-permission-reconciler.ts: a `delivered` revision is confirmed, never re-dispatched). The in-memory settlement only guards within one process — do not report restart replay here.
- Copy is humanized before send; HTML parse mode with escaped text.
- Settlement state (JobPermissionCardDeliverySettlement) is per channel instance; keys are derived from actionAffordances.

Focus: duplicate-send races, key collisions between different jobs/cards, edit-after-send ordering, stale message ids, HTML escaping of user/job text. Ignore style.
