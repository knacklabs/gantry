# ASKFLOOR-1-T2a task-contract grill — round 10

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2a` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md`. Inputs of record as in round 1 (`plans/exploration/askfloor-1-t2a-task-grill.md`); earlier briefs `-r2.md` … `-r9.md`.

Round 9 found one ownership overlap; folded exactly as proposed: the shape module owns `:248-260` and the pure `isProvablyWorkspacePath` `:361-366`; the hard-boundaries evaluator owns `:261-308` only; ownership is disjoint in AC2, §1 and the reviewer focus.

This is round 10: confirm the fold is consistent across task plan, `plan_contracts`, `acceptance_criteria` and `reviewer_focus`, and that no cited range overlaps between the two new modules. Blockers must be defects that would make the implementer build the wrong thing or make an AC unprovable.

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
