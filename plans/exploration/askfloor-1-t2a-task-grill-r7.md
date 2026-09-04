# ASKFLOOR-1-T2a task-contract grill — round 7

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2a` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md`. Inputs of record as in round 1 (`plans/exploration/askfloor-1-t2a-task-grill.md`); earlier briefs `-r2.md` … `-r6.md`.

Round 6 found three blockers; all folded:
1. AC1 now qualifies the birthright as complete, unsanitized, unredacted and well-shaped input; the universal "no real id is ever shortened" claim is gone (today's ids are short; no future bound claimed; a host-valid id tripping sanitization would be a separately scoped sanitization change).
2. The split classifies ONE parsed leaf; compound orchestration (`:120-140`), the raw-command protected/secret mention scans (`:429-468`) and the MCP branch (`:159,311`) stay in the gate verbatim; boundaries are per-target; two explicit parity leaves (compound; non-target protected mention).
3. Constitution: only the structure rules actually stated are cited; the file naming is a recorded, deliberate repo-wide deviation from the suffix table (siblings in `apps/core/src/shared` are `kebab-case.ts`).

This is round 7. Blockers must be defects that would make the implementer build the WRONG thing or make an AC unprovable; wording preferences and restatements are non-blocking notes. Verify (a) the three folds are consistent across task plan, `plan_contracts`, `acceptance_criteria`, `required_tests` (twelve plain `it` titles), `reviewer_focus`, `write_scope` (15), `review_budget` (16/1400); (b) that the split as now stated can reproduce every asserted reason string.

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
