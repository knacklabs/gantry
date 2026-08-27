# Review context: autonomous compound RunCommand fix (Q-0054-b975)

## The bug (live repro)
An autonomous scheduled job ran a control-flow compound bash command
`date +"%u %H %M %Z" && date +"%Y-%m-%d %H:%M %Z"`. The job already had rules
RunCommand(date *) and RunCommand(date +*) covering each leaf, yet the deterministic
permission rails CANCELLED the run ("no declared grant"), and the user then got TWO
notifications ("Needs permission" progress card + "Setup needed" story) and NO
approve button.

## The fix (this diff) — three parts + decision 0133
- Part A (tool-rule-matcher.ts): route RunCommand through the generic per-leaf
  `evaluateBashToolUse`; block piped commands. So an autonomous control-flow
  compound is allowed iff no pipe AND every leaf independently matches a granted
  RunCommand rule. No new authority — each leaf was already individually authorized.
- Part B (tool-execution-policy-service.ts + autonomous-bash-recovery-rule.ts):
  when the single-leaf grant recovery is undefined, fall back to
  autonomousCompoundBashRecovery, granting ALL per-leaf RunCommand rules so the
  setup card shows a working Approve button for genuinely-new compounds.
- Part C (execution-readiness.ts): notifyJobSetupRequired sets notified=true when
  the prompt is raised/already_pending so the pause emits one notification.

## Please scrutinize especially
1. GENERICITY: the logic must NOT special-case `date` — confirm it generalizes to
   any cli (e.g. `git status && npm ci`). Flag any command-name coupling.
2. LIVE PATH: confirm the change flips the REAL autonomous decision
   (ipc-permission-classifier-decision reviewed-rule path), not just a helper.
3. SAFETY: pipes must stay blocked; a compound with any unmatched leaf must still
   pause; per-leaf destructive redirects must block. No weakening of the boundary.
4. Part C completeness: does a setup-required pause emit exactly one user-visible
   message in ALL cases — raised, already_pending, instruction_only (the original
   buttonless repro), and prep-failed — or can the "Needs permission" progress card
   and the "Setup needed" story still both fire for ungrantable/pipe compounds?
5. decision 0133 wording matches the implemented invariant.
