# ASKFLOOR-1-T2b task-contract grill — round 14

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2b` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2b.md`. Inputs of record as in round 1 (`plans/exploration/askfloor-1-t2b-task-grill.md`); rounds 1–13 briefs and answers (rounds 7–13 were run on two models each: `-rN-answer.md` by gpt-5.6-sol @ xhigh, `-rN-answer-astra.md` by gpt-6-astra @ high).

Round 13 (astra @ high) found two consistency residues of the round-12 fold; both folded: the objective now states the HIGH/LOW/ambiguous partition ("LOW allows only under interactive_auto, HIGH asks in every lane, ambiguous goes to the classifier"), and `reviewer_focus` no longer says "loses only the identity-based native allow" nor `Promise<verdict>` for `judgeNativeFileWrite` — it names `{ verdict, reason }`.
SOL_R13_SECTION

Round 14 is the final consistency check: (a) `objective`, `acceptance_criteria`, `plan_contracts`, the task plan (diagram, Scope, Surface Impact, Risks, Decisions) and `reviewer_focus` agree on every rule; (b) `required_tests` (fifteen single-leaf `-t` titles), `write_scope` (23), `review_budget` (25/2100); (c) any remaining defect that would make the implementer build the wrong thing, make an AC unprovable, or contradict an accepted decision in `docs/decisions/*.md`. Keep the investigation focused on the recorded contract, the saved task plan, decisions 0130 and 0155, and only the source lines the ACs cite.

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
