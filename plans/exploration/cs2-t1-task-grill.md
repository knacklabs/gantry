# CARDSIMPLE-2-T1 TASK grill — cold read the implementer contract (read-only, adversarial, emit under ~500 words, do NOT explore beyond listed files)

You did NOT author this. Interrogate the T1 implementer contract against the actual code and the story contract. T1 = surface unification (fold the setup-pause prompt into the canonical job_permission_card, delete the setup-EXCLUSIVE prose surface, make card creation live-run-independent). T2 (out of scope here) owns the retract lifecycle + row actions.

Read ONLY:
1. `plans/exploration/cs2-t1-taskplan.md` (the contract under interrogation)
2. `apps/core/src/application/jobs/setup-pause-permission-prompt.ts` (:71 ingress, :128-148 first-reviewable, :237 identity)
3. `apps/core/src/app/bootstrap/job-permission-durability-wiring.ts` (:216-224 live-run/lease guard)
4. `apps/core/src/jobs/execution-readiness.ts` (:160 notifyJobSetupRequired, :221-231 send, :245-248 markJobSetupNotified)
5. `apps/core/src/application/jobs/scheduler-setup-story.ts` (:20 formatSchedulerSetupStory, :53-85 setupStoryActionAffordances)
6. `apps/core/src/jobs/execution-notifications.ts` (:159 recoveryActionAffordances, :177 runAgainActionAffordances, :241 notifySchedulerSetupRequired, :277 call site)

Hunt, each with file:line + verdict:
1. CORRECTNESS: does the contract correctly delete ONLY the setup-exclusive surface (setupStoryActionAffordances + its call site + the setup prose send) while RETAINING the shared scheduler_* kinds + 4 provider codecs that recoveryActionAffordances/runAgainActionAffordances also emit? Flag any step that would delete a shared codec/kind and break recovery/run-again cards.
2. IDENTITY: is folding to jobPermissionCardId(appId, jobId) with setupFingerprint as a dedupe key coherent given the durability-wiring guard removal? Any place the old setup-pause identity is still referenced after deletion (dangling)?
3. NOTIFIED_FINGERPRINT: is deriving from 0124 persisted state (not the transient raise result) actually reachable in execution-readiness, and does removing markJobSetupNotified there leave the reconciler correct (no loop, no double-mark)?
4. SCOPE BLEED: does anything in T1 stray into T2 (retract lifecycle, Apply/Recheck actions) or into the CARDSIMPLE-1 grant files?
5. TEST ADEQUACY: do the named required tests actually prove AC1-AC4 (esp. no-live-run creation, one identity, no prose/non-approver-silent, notified ownership)? Any missing negative/zero-reference gate?

OUTPUT: numbered findings — claim, file:line, class (correctness|scope|contract-gap|test-gap), severity (blocker|gap|nit), smallest fix. Separate any OWNER-LEVEL question into a final verbatim list (likely none — this is an implementer contract). End: "CONTRACT SOUND" or the blocker count. No edits.
