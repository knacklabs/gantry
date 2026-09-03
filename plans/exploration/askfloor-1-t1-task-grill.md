# ASKFLOOR-1-T1 TASK grill — round 1 (read-only, adversarial, emit under ~500 words; factory/prompts/griller.md --gate task)

You did NOT author this contract. Read the task `ASKFLOOR-1-T1` in `.factory/decomposition.json` (objective, acceptance_criteria, write_scope, verify_commands, required_tests, reviewer_focus, plan_contracts) and interrogate it against the approved plan `plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md` (Technical Approach §1, Task Decomposition T1, Verify Plan) and the code it names (read only what you need):
- `apps/core/src/runtime/ipc-permission-classifier-decision.ts` (:67-74 job guard, :95-119 rail callback, :173-452 tail: route guard :184-218, consult :220-305, veto :307-330, cache :333-367, prompt :369-452)
- `apps/core/src/runtime/permission-decision-coordinator.ts` (:43-60, :120-200)
- `apps/core/src/shared/permission-trusted-paths.ts` (`pathCandidates` ~:60-70), `apps/core/src/shared/bash-command-parser.ts` (:35, :563-590 — must stay untouched)
- tests: `apps/core/test/unit/runtime/ipc-permission-classifier-decision.test.ts`, `apps/core/test/unit/shared/permission-deterministic-rails.test.ts`, `apps/core/test/unit/shared/bash-command-parser.test.ts`

Hunt:
1. BOUNDEDNESS: is write_scope exactly what §1 needs and nothing of T2a/T2b/T3b (native risk, rails, memory)? Does the coordinator edit stay to "accept the analysis + return the rail decision once"? One Codex session?
2. PROOF: are the five required_tests executable as written (paths exist or are created by this task; ids are leaf testcase names; the vitest JUnit runner shape `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` matches this repo's config)? Do they prove AF-AC4 (routing half) and AF-AC8 S3, including the auto_strict / ask / job invariance?
3. INVARIANCE: can the relaxation leak to auto_strict, ask, autonomous, inline-scheduled? Is `pathCandidates` the right seam and is assumption A-askfloor-1 tested per lane?
4. SHAPE: does reviewer_focus demand the constitution-conformant shape (typed enums, pure analyzer, thin tail, named helpers) without inventing a layout; are the TODO(T2a)/TODO(T3b) deferrals honest?
5. Anything missing that the implementer will have to guess.

OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "CONTRACT SOUND" or the blocker count. No edits.
