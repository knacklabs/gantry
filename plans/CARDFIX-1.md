# Every pause card carries a real action

## What changes for you

- Attach `actionAffordances` at the neutral layer wherever a pause/setup story is delivered through the notification route: `notifyJobSetupRequired` → `sendJobNotification` already forwards `MessageSendOptions.actionAffordances` (`jobs/execution-notifications.ts:269`, `jobs/delivery.ts:152`). Call sites: preflight (`execution-phases-setup.ts:276`), final setup (`execution-phases-run.ts:220`), permission denied/timeout (`execution-finalization.ts:192`), partial recovery (`request-access-job-recovery.ts:68`).
- Action set: compound-command denial ⇒ **Allow once for this run** (retry-and-ask, ruled) + **Pause job**; other blockers ⇒ their existing grantable setup action plus **Pause job**; every delivered pause story carries ≥1 action.
- **Retry-and-ask** (owner-ruled mechanism): a new neutral affordance kind `scheduler_retry_ask` that triggers exactly one fresh re-run of the job with interactive asking for that run (the compound then arrives as the normal ask-and-wait card; the human's Allow applies as the existing JOBPERM-2 once-grant; nothing persisted). Fresh retry per 0115; no compound grant per 0134; ask lane per 0144. One-shot idempotency mirrors the setup-card hash pattern (`setup-pause-permission-wiring.ts:230`).
- **Pause job made real**: add the `scheduler_pause_job` variant to `MessageActionCallbackInput`, route it through `channel-message-action-router.ts`, and implement the handler next to `scheduler_run_now` (`runtime-live-stop-message-action.ts:199`) with the same same-channel approver authorization; the four providers' guidance replies become real dispatches by consuming the neutral callback (their renderers already emit the button).
- Tests: neutral invariant test that every `formatSchedulerSetupStory` delivery carries ≥1 affordance; router/handler unit tests per action; the existing per-provider affordance render tests extend to the new kind (Telegram `telegram.test.ts:3413`, Slack `slack.test.ts:4819`, Discord `discord.test.ts:470`, Teams `teams.test.ts:1744`, parity `provider-affordance-parity.test.ts:31`).

**Non-goals**: the durable setup approval card's own decision options (`setup-pause-permission-prompt.ts` — it stays as is; its `decisionReason` story is not a notification delivery); `transient_permission` (delivered nowhere today — unchanged); reworking 0134/0144 policy; a pre-authorized once mechanism (rejected in grill); the six GRACE-1 findings; provider-specific handlers of any kind (owner directive: neutral only).

## Why

A job paused by a tool denial or incomplete setup tells its owner "Setup needed" and offers nothing to press. Live evidence (2026-08-31, job `card-check-2`): a piped `RunCommand` was correctly refused per-leaf authorization (0134), the run paused, and the owner got a plain-text story with an empty action surface on Slack — `formatSchedulerSetupStory` (`apps/core/src/application/jobs/scheduler-setup-story.ts`) returns text only, and no `actionAffordances` are attached at any of its delivery call sites. Worse, the "Pause job" button that other scheduler notices render is guidance-only on every provider: `MessageActionCallbackInput` has no `scheduler_pause_job` variant, so each provider replies "use the scheduler" instead of pausing (`domain/message-actions.ts:62`; Telegram `callback-handlers.ts:725`, Slack `channel-message-action-handler.ts:305`, Discord `interactions.ts:337`, Teams `message-actions.ts:407`).

## Done when

1. AC1: every `formatSchedulerSetupStory` delivery reaches the channel with at least one working action affordance, on all four providers, via the neutral affordance path; no pause/setup message is ever sent action-less.
2. AC2: the compound-command denial card offers exactly Allow-once-for-this-run (retry-and-ask) and Pause job, and never a durable-grant button (0134 holds); the retry runs the job once in ask mode and is idempotent per pause story.
3. AC3: tapping each offered action performs its effect through the neutral router — retry-and-ask starts one fresh run, Pause job pauses the job (same-channel approver authorized) — unit-tested per action; provider render covered by the existing per-provider affordance tests.
4. AC4: existing unit and Postgres integration suites pass; tsc and check:architecture green.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | Pause stories carry real actions: retry-and-ask + real Pause job, neutral layer | Attach action affordances to every pause/setup story delivery in the neutral layer (notification route already forwards them); add scheduler_retry_ask (one-shot rerun in ask mode; the compound arrives as the normal ask-and-wait card, approval is the existing once-grant, nothing persisted) and make scheduler_pause_job a real pause (callback variant + router + handler, same-channel approver); providers only consume the neutral callback. | 2, 3, 4 | `apps/core/src/domain/message-actions.ts`, `apps/core/src/jobs/`, `apps/core/src/application/jobs/`, `apps/core/src/app/bootstrap/`, `apps/core/src/channels/telegram/callback-handlers.ts`, `apps/core/src/channels/slack/channel-message-action-handler.ts`, `apps/core/src/channels/discord/interactions.ts`, `apps/core/src/channels/teams/message-actions.ts`, `apps/core/test/`, `apps/core/src/channels/slack/message-action-affordances.ts`, `apps/core/src/channels/telegram/message-action-affordances.ts`, `apps/core/src/channels/discord/components.ts`, `apps/core/src/channels/teams/cards.ts`, `apps/core/src/channels/telegram/scheduler-callback.ts`, `apps/core/src/channels/discord/scheduler-interactions.ts` | `apps/core/test/unit/jobs/execution-notifications.test.ts`, `apps/core/test/unit/application/scheduler-message-actions.test.ts` | none | yes |

New moving parts: none named in the old plan

## Risks

- Double delivery: the durable setup card and the notification route coexist; the approver-route exclusion (`execution-readiness.ts:216`) must keep holding so buttons don't appear twice.
- Idempotency: a tapped retry must not stack runs — one-shot key per pause story (setup fingerprint hash pattern).
- Per-run ask override: must not leak into subsequent scheduled runs (exactly one run).
- Review budget: neutral types + wiring + handler + 4 provider consumers + tests ≈ 14–18 files.

## Notes

Converted from plans/active/CARDFIX-1-every-pause-card-carries-a-real-action.md by forge migrate.

### Technical Approach

Copy SCHED-4B's shape end to end: build affordances where the story is built (neutral), deliver via the existing options field, route via the one router, act in the one runtime handler. New affordance kind `scheduler_retry_ask` (carries jobId + a one-shot key derived from the pause story's setup fingerprint); `scheduler_pause_job` gains its callback variant and handler. The ask-mode one-shot rerun reuses the existing trigger path with a per-run permission-mode override — the exploration's option 1 lane (ask-and-wait need, `job-permission-durability-wiring.ts:215`) without any new durable grant storage. Implementer is Codex `gpt-5.6-sol` @ `xhigh` (owner-specified), one bounded task.

### Decisions

0115 (fresh retry, no silent substitution) — honoured: retry-and-ask starts a new run. 0134 (pipe = hard boundary) — honoured: no compound grant, ever. 0144 (ask-and-wait lane) — honoured: the rerun asks via the standard card. 0121 (no classifier on autonomous) — untouched: the override makes the run interactive, not classified. 0127 (tagged setup action model) — the new kinds join the tagged model. No new decision required; if the implementer finds the per-run ask override needs a durable contract, raise a signal rather than inventing one.

### Surface Impact

Runtime behaviour (pause stories gain buttons; Pause button becomes real on all providers), neutral domain types (`message-actions.ts` union + callback variant), scheduler notification wiring, runtime message-action handler, four provider callback consumers lose their guidance-only stubs. No settings, storage schema, contracts/SDK, or migration changes expected.

### Task Decomposition

- CARDFIX-1-T1: affordances on pause stories + retry-and-ask + real Pause job + tests. Contract: AC1–AC4.

### Verify Plan

`npx tsc --noEmit`; `npm run check:architecture`; `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/channels/ apps/core/test/unit/application/ apps/core/test/unit/jobs/ apps/core/test/unit/domain/`; Postgres lane host-side (permission-decision-chain + job-lifecycle suites); autoreview local with a brief pinning AC1's never-action-less invariant and the 0134/0115 constraints; live check after deploy: re-trigger `card check 2`, the pause card must show Allow once + Pause job on Slack, tapping Allow once must produce the ask card, and Pause must pause the job.
