# Review brief — lite window Q-0073 (JOBPERM-1 incident fix continuation)

Incident: a Telegram job-permission card was sent as a NEW message on every delivery revision (duplicate cards), buttons rendered as plain text, and copy was machine-like.

Contract for this diff:
- One Telegram card per job-permission request across ALL delivered revisions: first revision sends, later revisions EDIT the same message (by previous message id). Never a second send for the same card.
- Re-delivery of an already-delivered revision returns the recorded message id without any provider mutation (idempotent).
- Card renders a native inline keyboard built from actionAffordances; a card with no valid actions is an error, not a plain-text send.
- Copy is humanized before send; HTML parse mode with escaped text.
- Settlement state (JobPermissionCardDeliverySettlement) is per channel instance; keys are derived from actionAffordances.

Focus: duplicate-send races, key collisions between different jobs/cards, edit-after-send ordering, stale message ids, HTML escaping of user/job text. Ignore style.
