# JOBPERM-1-T1 — Single-cut ask-and-wait lane core

Contract: implement v9 sections A1/A3 core + Deletions for the SIMPLE case
(one need, confirmed delivery assumed, approve/deny, resume, persistence,
browser await, truthful texts). Durability machinery (need states/reconciler/
outbox/living card/lease-slot) is T2; edges are T3.

Steps:
1. DELETE per v9 Deletions: the autonomous hard-return
   (permission-callback.ts:265-276) and lane condition on unbounded wait; the
   autoClassifierWait branch + AUTO_PERMISSION_CLASSIFIER_WAIT_MS; the
   duplicate hard-return (runner/permission-ipc-client.ts:228-239); the
   interactive-only condition in ipcInteractionAuthValidationOptions; the
   GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS special-casing; the no-grant
   "unattended" denial prose (keep explicit-deny + hard-boundary texts).
2. Host seam: soften the hostJobId cancel
   (ipc-permission-classifier-decision.ts:184-210) to fall through to the
   interactive tail (:447) when the request has a deliverable approver route;
   keep rails-first; classifier stays off (0121); no allow_once in the
   decisionOptions for jobId requests (setup-card precedent).
3. Worker: jobId-bearing requests poll unbounded (omit expiresAt), signed with
   the 24h unbounded-interaction authPurpose.
4. Persistence: on allow_persistent_rule without setupFingerprint, derive the
   job requirement from approved rules + jobId (requirementForRule dedup);
   live-rule file gives same-run silent allow.
5. Truthful texts: fix the "Allowed by..." denial-reason assembly
   (tool-permission-gate.ts:571 / autonomous-permission-recovery.ts).
6. Tests: new TOP-LEVEL it() file
   apps/core/test/unit/application/jobperm-ask-and-wait.test.ts with ids
   jobperm-1-t1-card-not-cancel, jobperm-1-t1-resume-and-persist,
   jobperm-1-t1-deletions-asserted (exact names; JUnit -t match). Focused
   suites for every touched module stay green.

Verify: required_tests JUnit green; check_dual_runtime clean; autoreview with
plans/review-briefs/scheduled-job-permission-parity-design.md as the contract.
