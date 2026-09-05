# ASKFLOOR-1-T2b task-contract grill — round 16

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2b` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2b.md`. Inputs of record as in round 1 (`plans/exploration/askfloor-1-t2b-task-grill.md`); rounds 1–15 briefs and answers.

Round 15 (sol @ xhigh, `-r15-answer.md`) found ONE blocker: four summaries (task plan Scope, Decisions and Risks lines; the recorded objective) still stated the pre-bullet-13 rule ("no native verdict outside interactive auto except capability_run"; "ambiguous goes to the classifier"). All four now state the three-way rule (LOW allows only under `interactive_auto`; HIGH asks in every lane; ambiguous consults under `interactive_auto`, yields nothing under `auto_strict`, asks natively with the lane absent); the plan was re-saved and the decomposition re-recorded.

Round 16 confirms the fold ONLY: (a) no sentence in the objective, acceptance criteria, plan contracts, `reviewer_focus` or the saved task plan (Scope, Decisions, Risks, Surface Impact, diagram) still states that the lane-less path yields no native verdict for ambiguous rows or that ambiguous unconditionally goes to the classifier; (b) the rule is consistent with decisions 0121, 0130 and 0155 bullets 7–13; (c) nothing else changed. Do not re-litigate settled rulings; do not re-derive the implementation.

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
