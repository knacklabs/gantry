# ASKFLOOR-1-T2a task-contract grill — round 8

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2a` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md`. Inputs of record as in round 1 (`plans/exploration/askfloor-1-t2a-task-grill.md`); earlier briefs `-r2.md` … `-r7.md`.

Round 7 found two blockers; both folded:
1. `classifyPermissionEffectShape(leaf, { stdinOk })` — the pure compound/pipeline context the orchestration already derives (`auto-permission-read-only-gate.ts:129,164`); `requiresTarget` is derived inside the classifier; a standalone-versus-piped `cat` parity leaf is required.
2. The move/retain boundary now names the current code: `grepFileArgs` (`:429-468`) moves INTO the shape module; the retained whole-command raw guards are `:115-122` and `:149-150`; the non-target protected-mention case is a required composition leaf (the existing `:342-346` case is the workspace-root one).

This is round 8. Blockers must be defects that would make the implementer build the WRONG thing or make an AC unprovable. Verify only: (a) that the two folds are consistent across task plan, `plan_contracts`, `acceptance_criteria`, `required_tests` (twelve plain `it` titles), `reviewer_focus`; (b) that every line range cited for the read gate and its test now matches the current file.

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
