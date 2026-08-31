# Review brief — quickfix Q-0123 (Slack invalid_blocks: duplicate action_ids)

Facts (live 2026-08-31 10:09Z): the first two-button Slack job permission card (job-card-check-2, delivery c6202616) failed with Slack API `invalid_blocks` and exhausted both delivery attempts, parking the run. Every Slack button carried the same `action_id: 'gantry_message_action'`; Slack requires action_ids to be unique within one actions block. One-button messages worked, so this never surfaced.

Contract for this diff: every Slack button builder (message-action-affordances two builders, brain-review-affordances, observer-digest-affordances) emits `gantry_message_action:<index>`; the bolt handler registers `/^gantry_message_action(:\d+)?$/` so suffixed and legacy bare ids both route; `SlackAppLike.action` widened to accept RegExp. Tests updated (lookup via the existing regex-aware helper; uniqueness asserted on a two-button block).

Focus: the handler still receives and parses `action.value` identically (payload shape untouched); no builder changed its value/label/style logic; legacy messages already in channels (bare id) still route. Ignore style.
