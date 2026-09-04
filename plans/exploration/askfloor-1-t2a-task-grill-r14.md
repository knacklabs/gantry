# ASKFLOOR-1-T2a task-contract grill — round 14

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2a` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md`. Inputs of record as in round 1 (`plans/exploration/askfloor-1-t2a-task-grill.md`); rounds 2–13 briefs `-r2.md` … `-r13.md`.

Round 13 found one blocker; folded: `askfloor-tap-budget-harness.ts` joins the write scope; `TapBudgetFixture` gains an optional `attachmentOpenIds` field that `replayPermissionRequest` forwards onto the request; the S1 fixture pins `mcp__gantry__attachment_open` with `{ wellFormed: true, count: 1 }`; 19 files; budget reason corrected (10 source + 9 test = 19 under 20/1600).

Round 14 is a consistency check only: confirm the fold is reflected in the task plan (AC4, §4, Task Decomposition), `plan_contracts`, `acceptance_criteria`, `required_tests` (thirteen plain `it` titles), `reviewer_focus`, `write_scope` (19) and `review_budget`. Blockers must be defects that would make the implementer build the wrong thing or make an AC unprovable.

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
