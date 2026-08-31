# CARDSIMPLE-1 validation pass 1 of 4 — Setup-card removal blast radius (read-only, no edits)

Scope ONLY this question; keep reading tight and answer fast. The draft spec `docs/specs/cardsimple-1-one-permission-surface.md` deletes the "Setup needed" pause-story prose message and makes the job permission card the only surface for a blocked need.

Find every consumer/flow that depends on that pause-story delivery: `apps/core/src/jobs/execution-notifications.ts` (notifyJobSetupRequired / notifySchedulerSetupRequired), `apps/core/src/application/jobs/scheduler-setup-story.ts` (formatSchedulerSetupStory + setupStoryActionAffordances), `apps/core/src/app/bootstrap/setup-pause-permission-wiring.ts`, and the provider render paths. The just-merged CARDFIX-1 (#460/#462) put `scheduler_retry_ask` / `scheduler_pause_job` affordances ON that prose delivery — if it dies and the permission card is the only surface, where do those actions live, and does the permission card exist for every pause cause (e.g. tool-only blockers with no ask card in flight)?

Output: numbered findings — claim, file:line, severity (blocker | design-gap | nit), smallest spec amendment. Nothing else.
