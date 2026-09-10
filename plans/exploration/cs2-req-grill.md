# CARDSIMPLE-2 requirements grill — cold read the spec vs CURRENT repo (read-only, adversarial, emit under ~500 words, do NOT explore beyond listed files)

You are an adversarial cold reader who did NOT author this. Interrogate the CARDSIMPLE-2 slice of the confirmed spec against the CURRENT worktree code and find gaps/contradictions/staleness that would cause rework. CARDSIMPLE-1 (family grants) ALREADY SHIPPED to main and is merged into this worktree; CARDSIMPLE-2 is the "One canonical card" slice only.

Read ONLY these, then emit findings:
1. `docs/specs/cardsimple-1-one-permission-surface.md` — the "### One canonical card" section + AC1 (that is CARDSIMPLE-2's contract; grants/late-tap already shipped in CARDSIMPLE-1).
2. `apps/core/src/application/jobs/setup-pause-permission-prompt.ts` (the second card impl to fold in; note line refs :71 ingress, :122 first-reviewable narrowing)
3. `apps/core/src/app/bootstrap/job-permission-durability-wiring.ts` (:215 live-run/lease attachment requirement)
4. `apps/core/src/application/jobs/execution-readiness.ts` (:182 raised|already_pending; :245 notified_fingerprint prose-send marking)
5. `apps/core/src/application/jobs/job-readiness-service.ts` (setup_state + the invalidAgentToolPolicyBlocker path)

Hunt specifically:
- Do the spec's file:line anchors still match current code (CARDSIMPLE-1 + tonight's settings-tolerance/grant-projection changes may have shifted them)?
- The spec says the setup-pause prompt is a "second parallel card implementation" to fold into `job_permission_card`. Is that still accurate, or did anything already converge/diverge?
- AC1 requires "no second actionable surface" and "reconciler does not loop on unnotified pauses" and "notified_fingerprint owned by card delivery." Are there current seams that contradict these (e.g. the prose send still owns notified_fingerprint)?
- NEW REALITY to reconcile: a stale setup_state blocker can persist on a RUNNING (non-paused) job and the retry no-ops (`isSetupPausedJob` guard in job-permission-recovery.ts); and a ready run-start does not retract a stale setup card. Does CARDSIMPLE-2's "one canonical card that settles/retracts" contract need an explicit AC for clearing/retracting a stale setup_state on a non-paused job? Flag as an owner-level requirements question if so.
- Any behaviour the spec omits that the current code proves necessary; any implementation choice masquerading as a requirement.

OUTPUT: numbered findings — claim, file:line, severity (blocker|gap|nit), and whether it is an OWNER-LEVEL question (needs Ravi) or a spec-text fix. End with the list of OWNER-LEVEL questions verbatim (these become AskUserQuestion rounds). No edits.
