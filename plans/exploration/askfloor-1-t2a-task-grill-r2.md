# ASKFLOOR-1-T2a task-contract grill — round 2

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2a` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md`. Same inputs of record as round 1 (`plans/exploration/askfloor-1-t2a-task-grill.md`).

Round 1 found four blockers; all were folded:
1. Shape result now carries `action`, `targets` and `requiresTarget` (capability matching and reason strings at `auto-permission-read-only-gate.ts:248,297`).
2. The attachment predicate runs on the COMPLETE raw tool input BEFORE the display-sanitization veto (`runtime/ipc-tool-input-sanitization.ts:6`, rails `:125`), with 512/513 boundary tests.
3. `runtime/ipc-permission-classifier-decision.ts` (cache-hit constructor `:293`) and its test file joined the write scope; cache hits stamp `skipped`; budget 18 files / 1500 lines; a twelfth required test.
4. T2a-AC5 restored to the story's wording (unit + Postgres suites; Postgres lane orchestrator-run evidence as for T1).

Verify each fold is complete and consistent across task plan, `plan_contracts`, `acceptance_criteria`, `required_tests`, `reviewer_focus` and `write_scope`; then re-interrogate items 2–9 of the round-1 brief against the amended contract. In particular: does the rails input actually expose the raw (un-sanitized) tool arguments at `:110-142`, and if not, which existing field or caller carries them? Are the twelve ids exact plain `it` titles?

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
