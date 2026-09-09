# Critique brief — does the Symphony Forge workflow beat plain plan-and-implement?

Owner question (Ravi, 2026-09-09): "Validate and critique the overall workflow. Will it speed up development AND accuracy compared to a general plan-and-implement loop? Developers cannot process parallel tasks manually — it is too much cognitive load."

You are one of two independent reviewers (a Fable model with session context; a Sol xhigh cold read). Answer in plain English for Ravi, with citations to files and lines. Be adversarial: the point is to find where the workflow loses, not to praise it.

## What to read

- Harness: `~/Workdir/symphony-forge` on branch `feat/one-review-per-task` (PR #189, stacked on merged #188). Start with `WORKFLOW.md` (per-task loop, steps 1–11), `.claude/skills/forge/SKILL.md`, `factory/scripts/forge_cli/{stages,tasks,review,review_brief,delegate,grill}.py`, `factory/prompts/{planner,griller,decomposer,reviewer}.md`.
- Evidence of cost on a real client: `~/Workdir/myclaw-askfloor1/plans/exploration/process-simplification-proposal-2026-09-09.md` (T5a numbers), `workflow-audit-fable-2026-09-09.md` (the first audit), `forge-gate-audit-validation-2026-09-09.md` (an external audit of another client, validated line by line; it contains the four owner decisions at the end).
- The four decisions already taken (apply them as given, do not re-litigate): (1) `stage done` refuses only on failing verification or a blocking review; scope/budget/test-name mismatches are measured and recorded. (2) Bounded coordinator fixes (≤5 files, recorded, reviewed) are allowed without a Codex launch. (3) The plan review records findings against a version; approval once; harness-owned writes never re-open it. (4) Per-task PRs stay.
- Planned next: task-level parallelism inside a story (dependency-gated task/stage start, a second active stage when write scopes are area-disjoint, per-task stage records, `forge next` listing all ready tasks).

## What to answer (in this order, each with a verdict and evidence)

1. **Speed.** For a typical 40–60-file task, estimate wall-clock and human touches under (a) plain plan-and-implement with one review, (b) the workflow as it stands after #189 + the four decisions, (c) with task-level parallelism. Name the steps that still dominate and whether they are load-bearing for accuracy or ceremony.
2. **Accuracy.** Which gates demonstrably catch defects that plan-and-implement would miss (cite the T4/T5a evidence: hardFloor guard gaps, the No-fallback, the receipt-without-storage, the S4 contract broken by a review's own fix)? Which gates produce false positives or contradictions (the review vs T3b-AC3 case)? Net: does the workflow raise accuracy, and where does it lower it?
3. **Cognitive load with parallel tasks.** The developer cannot supervise several Codex runs at once. Does the workflow make parallel tasks self-driving — owner questions bundled up front, signals resolved by the coordinator, one board — or does it multiply the human's interrupts? Where would a human be forced to arbitrate, and how should that be removed (e.g. per-task briefs that pre-answer, a single owner-question round for the whole story, merge order decided by the dependency graph)?
4. **Failure modes.** What breaks first when two or three tasks run in parallel worktrees: the companion lock, ledger merges, trunk merge order, review base drift, the frontier? For each: how the harness should behave, minimal design.
5. **Verdict.** Yes/no/conditional on "beats plan-and-implement on speed and accuracy", with the three changes that matter most if conditional, and anything in the current design you would remove outright.

Under ~250 lines. No session links. Write to the path you are given; return the path and a 10-line summary.
