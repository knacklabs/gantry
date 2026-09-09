# Two critiques of the workflow, one page — 2026-09-09

Ravi asked two independent reviewers the same question: after #188/#189 and the four decisions, does the workflow beat plain plan-and-implement on speed and accuracy, given that a developer cannot supervise parallel tasks? A Fable review with this session's context (`workflow-critique-fable-2026-09-09.md`) and a Sol xhigh cold read (`workflow-critique-sol-2026-09-09.md`, recovered from the job log).

## Where they agree

- **Accuracy: yes, already.** Both credit the review loop with real catches on T5a (six defects, and the S4 scenario test catching the review's own wrong fix), and both name the same accuracy leak: a reviewer without the settled contracts contradicted T3b-AC3 for three rounds. #189's settled section, rejection ledger and lessons are the right shape for that leak.
- **Single-task speed: no.** Fable: 6–9 h against 3–5 h for a plain loop on a 40–60-file task. Sol: 9–15 h and 4–6 human touches against 7–12 h and 2–4 touches. Neither expects the workflow to beat plan-and-implement on one task; the win has to come per story.
- **Parallelism only pays for independent leaves**, and per-task state files break before companion locks do: `.factory/stages.json` is one file per story, so two worktrees rewrite it. Both put per-task stage records first.
- **Not yet self-driving.** As long as approvals and grill findings interrupt per task, a developer cannot run two tasks without arbitrating between them.

## Where they differ

- Fable proposed one owner round and one approval per story. **Ravi rejected that** (2026-09-09): developers cannot think a story through at story level; the owner questions that mattered on T5a/T5b only surfaced when each task plan met the real code. Per-task planning, grilling, bundled owner questions and one approval per task stay. Sol did not propose the story-level round; it asked for "supervisor-owned concurrency" — the coordinator, not the human, handles per-task interrupts.
- Sol notes that the T4/T5a defect list in the evidence documents is not individually substantiated in the artifacts it could read (it saw the summaries, not the review logs). Fair; the review artifacts are in the myclaw worktrees' `.factory/` and were not in its scope.

## What this changes in the plan

Nothing in direction; two things in emphasis. (1) The self-driving property is the cognitive-load answer: per-task briefs carry the sibling tasks' sealed contracts and the story rulings, sibling-scope conflicts are refused rather than arbitrated, merge order follows the dependency graph, and the human is asked only the bundled owner questions per task — this is in the parallelism PR's brief. (2) Speed is claimed per story, not per task; a story with three area-disjoint tasks is where the workflow should first be measured against a plain loop.
