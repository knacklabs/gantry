# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task CARDFIX-1-T1

### Plan contracts

- **CARDFIX-1-AC1**
  - Source: plans/active/CARDFIX-1-every-pause-card-carries-a-real-action.md#acceptance-criteria
  - Statement: every formatSchedulerSetupStory delivery reaches the channel with at least one working action affordance, on all four providers, via the neutral affordance path; no pause/setup message is ever sent action-less.
- **CARDFIX-1-AC2**
  - Source: plans/active/CARDFIX-1-every-pause-card-carries-a-real-action.md#acceptance-criteria
  - Statement: the compound-command denial card offers exactly Allow-once-for-this-run (retry-and-ask) and Pause job, and never a durable-grant button (0134 holds); the retry runs the job once in ask mode and is idempotent per pause story.
- **CARDFIX-1-AC3**
  - Source: plans/active/CARDFIX-1-every-pause-card-carries-a-real-action.md#acceptance-criteria
  - Statement: tapping each offered action performs its effect through the neutral router — retry-and-ask starts one fresh run, Pause job pauses the job (same-channel approver authorized) — unit-tested per action; provider render covered by the existing per-provider affordance tests.
- **CARDFIX-1-AC4**
  - Source: plans/active/CARDFIX-1-every-pause-card-carries-a-real-action.md#acceptance-criteria
  - Statement: existing unit and Postgres integration suites pass; tsc and check:architecture green.

### Reviewer focus

- Neutral only: affordances built where the story is built; providers ONLY consume the neutral callback (owner directive — no provider-specific handlers).
- 0134 holds: never a durable-grant button for a compound; retry-and-ask persists nothing and the per-run ask override applies to exactly one run (0115 fresh retry; 0121 untouched).
- Double delivery: the approver-route exclusion (execution-readiness.ts:216) must keep the durable setup card and the notification route from showing buttons twice.
- Idempotency: one-shot key per pause story (setup fingerprint hash pattern, setup-pause-permission-wiring.ts:230); a tapped retry must not stack runs.
- Slack buttons: unique index-suffixed action_ids (fix #458) — keep using slackMessageActionBlocks, never hand-built blocks.
- If the per-run ask override seems to need a durable contract, raise a signal — do not invent a decision.
