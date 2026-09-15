# CARDSIMPLE-2 PLAN grill — cold read for simplicity + UX + contract (read-only, adversarial, emit under ~600 words, do NOT explore beyond listed files)

You did NOT author this plan. Interrogate it as an adversary against simplicity, UX, and contract fidelity. CARDSIMPLE-1 (family grants) already shipped; this is the card-unification slice.

Read ONLY:
1. `plans/exploration/cs2-plan-source.md` (the plan under interrogation)
2. `docs/specs/cardsimple-1-one-permission-surface.md` — the "### One canonical card" section + AC1 (the contract)
3. `apps/core/src/application/jobs/setup-pause-permission-prompt.ts` (:71 ingress, :103-119 cancel/retire, :122 first-reviewable, :166-200 shared request builder, :220-256 identity)
4. `apps/core/src/jobs/execution-readiness.ts` (:226-234 raised|already_pending, :245 prose-send notified marking)
5. `apps/core/src/application/jobs/job-permission-recovery.ts` (:117 isSetupPausedJob guard)

Hunt, with file:line + a concrete verdict on each:
1. SIMPLICITY: is any step over-built or bigger than the goal needs? The goal is "two parallel cards -> one canonical card that retracts when the blocker clears." Flag any step that adds machinery instead of deleting it, any new state/field the existing 0124 delivery + setup_state already provide, any abstraction for a single use. Is the ~30-file/1200-line estimate mostly DELETION (good) or new code (suspect)?
2. UX: does the plan actually deliver "disappears like a chat permission card"? Specifically — (a) is auto-retract-on-ready reachable on the paths that matter (run-start, reconcile) given RULING 2, or is there a path where a resolved blocker still lingers? (b) is dropping Dismiss correct, or is there a legitimate case where a user must clear a card that will never auto-clear (a permanently-unsatisfiable blocker)? (c) does the Recheck affordance on instruction rows actually trigger a real readiness re-check + retract, given the isSetupPausedJob relaxation in step 4?
3. CONTRACT: does the plan satisfy AC1 (one surface, matrix, no prose, approver-only, notified_fingerprint owned by delivery, no reconciler loop, no second surface)? Any AC clause with no corresponding step? Does the scope-disjoint list actually cover every CARDSIMPLE-1 grant file the card work might otherwise touch? Any active decision (0124/0144/0134/0106) the plan contradicts?
4. RISK: the biggest correctness risk in a deletion-heavy cutover (a dangling caller of a deleted codec/affordance; a route that still sends prose; a reconciler path still keyed on the old notified marking).

OUTPUT: numbered findings — claim, file:line, class (over-build | ux-gap | contract-gap | risk), severity (blocker|gap|nit), and the smallest fix. Separate any OWNER-LEVEL question (needs a human ruling) into a final verbatim list. End: "SIMPLE ENOUGH + UX SOUND" or the blocker count. No edits.
