# ASKFLOOR-1-T2b task-contract grill — round 6

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2b` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2b.md`. Inputs of record as in round 1 (`plans/exploration/askfloor-1-t2b-task-grill.md`); rounds 1–5 briefs and answers.

Round 5 found two textual blockers; both folded: the task `objective` now lists raw-path browser file actions among the ambiguous set (not HIGH) and states "other lanes keep today's verdict"; the workflow diagram now branches on the lane FIRST (ask/autonomous never consult; absent/auto_strict use today's eligibility with `FileWrite`/`FileEdit` ineligible; only `interactive_auto` adds the two facade ids), then the pure table.

Round 6 is the final consistency check: (a) `objective`, `acceptance_criteria`, `plan_contracts`, the task plan (including the diagram and Surface Impact) and `reviewer_focus` agree on every rule; (b) `required_tests` (fourteen single-leaf `-t` titles), `write_scope` (22), `review_budget` (24/2000); (c) any remaining defect that would make the implementer build the wrong thing or make an AC unprovable.

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
