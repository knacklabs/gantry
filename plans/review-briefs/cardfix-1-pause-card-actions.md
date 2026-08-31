# Review brief — CARDFIX-1 (every pause card carries a real action)

Facts: pause/setup stories (formatSchedulerSetupStory) delivered as plain text with zero action affordances on every provider (live: job card-check-2, compound RunCommand denial per 0134); the rendered "Pause job" button was guidance-only on all four providers (no MessageActionCallbackInput variant).

Contract for this diff:
- AC1: every delivered pause story carries >=1 working affordance, attached in the NEUTRAL layer (notification route's existing actionAffordances field); providers only render/consume — no provider-specific handlers.
- AC2: compound denial card = exactly [Allow once for this run (retry-and-ask), Pause job]; NEVER a durable-grant button (0134); retry is idempotent per pause story (one-shot key, setup-fingerprint hash pattern).
- AC3: retry-and-ask starts exactly ONE fresh run with a per-run interactive-ask override (0115 fresh retry; the ask lands as the normal ask-and-wait card; approval = existing once-grant; nothing persisted; the override must not leak into later scheduled runs); Pause actually pauses, same-channel approver authorized like scheduler_run_now.
- AC4: suites/tsc/architecture green; Telegram behaviour otherwise unchanged.

Focus: (1) double delivery — the approver-route exclusion (execution-readiness.ts:216) must still prevent the durable setup card and the notification route from both showing buttons; (2) a tapped retry must not stack runs (crash between tap and run start included); (3) the per-run ask override's scope — exactly one run, no durable trace; (4) Slack blocks built only via slackMessageActionBlocks (unique index-suffixed action_ids, fix #458); (5) non-approver taps rejected consistently across providers. Ignore style.
