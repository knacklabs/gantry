# CARDSIMPLE-1 plan grill — pass C of 3: T3 + decisions + executability (read-only, no edits, keep reading TIGHT)

You did not author this plan. Read `plans/exploration/cardsimple-1-plan-draft.md` cold as an adversary. Scope ONLY these three questions; answer fast.

1. **T3 sufficiency.** The plan deletes the per-dead-priorRunId rerun-barrier fanout (`application/interactions/job-permission-provider-actions.ts:166`, `job-permission-durability-state.ts:81`, `job-permission-reconciler.ts:498`) and adds a tap-time run-lease check returning `live | late`. A prior partial cold-read established the handoff trigger has NO consumer beyond the reconciler/wiring pair, but flagged: the plan does not define (a) the state matrix distinguishing a valid late card from an expired or retired revision (states: handoff_pending, handed_off, retired, expired), nor (b) the new single-trigger path that makes a paused job runnable before dispatch (Run now must activate the job, then create/enqueue exactly one trigger, failed dispatch settles it — via the #462 interactive lane at `app/bootstrap/runtime-live-stop-message-action.ts:122`). Verify both gaps against code and propose the smallest state-matrix + dispatch-path wording the plan needs. Late Deny (amended spec): denial receipt, no Run now, Reconsider retained.

2. **Decisions.** Any conflict with active decisions the plan does not name (0106, 0121, 0124, 0127, 0134, 0144, JOBPERM-2 grant shapes)? Should the planned NEW decision (rails-before-family-match, explicitly amending 0121/0144 for the family rail-hit case) also amend or supersede anything else?

3. **Executability.** Are the per-task verify plans and the T1/T2 parallel + T3-after-T2 DAG realistic? Name any file the tasks must touch that the plan never mentions.

Output: numbered findings — claim, file:line, severity (blocker | design-gap | nit), smallest plan amendment. Say "CLEAN" if nothing. No edits.
