# ASKFLOOR-1-T1 TASK grill — round 2 (read-only, adversarial, emit under ~350 words; factory/prompts/griller.md --gate task)

You did NOT author this contract. Round 1 returned 5 blockers; the task `ASKFLOOR-1-T1` in `.factory/stories/ASKFLOOR-1/decomposition.json` was re-recorded:
1. `plan_contracts` now equal the five T1 acceptance criteria verbatim (ids T1-AC1..AC5, source the saved task plan).
2. write_scope enumerates the exact test files (nine) plus the harness module `apps/core/test/unit/runtime/askfloor-tap-budget-harness.ts` whose exported contract (`replayPermissionRequest(fixture) → { taps, decidedBy, provenance }`, `TapBudgetFixture`) is named in reviewer_focus.
3. required_tests: 8 leaves — out_of_trusted_root allow (auto) + veto (auto_strict/ask/job); read-only find allow (auto) + veto (other lanes); analyzer nine-action refusal; parser-owned nine-action refusal pin; /dev/null non-path per lane; coordinator once-only rail evaluation + unchanged analysis threading; S3 replay.
4. verify_commands: `python3 factory/scripts/verify.py`, tsc, check:architecture, `npm run test:integration:postgres` (env exported by the orchestrator).

Verify each is closed against the saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T1.md` and the code it names (read only what you need); hunt anything NEW (boundedness, proof asymmetry, invariance leaks, shape).

OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "CONTRACT SOUND" or the blocker count. No edits.
