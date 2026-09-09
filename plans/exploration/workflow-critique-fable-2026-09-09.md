# Workflow critique — Fable reviewer, 2026-09-09

Question from Ravi: will Symphony Forge, after #188/#189 and the four decisions, beat a plain plan-and-implement loop on speed AND accuracy, given that a developer cannot supervise parallel tasks?

Short answer: **conditional yes.** On accuracy it already wins, and the evidence is concrete. On speed it does not win yet; after #189 it roughly breaks even on a single task, and it only pulls ahead when tasks run in parallel with the human out of the loop. Three changes decide it (section 5).

Evidence base: harness branch `feat/one-review-per-task` at 00ba3c1; the T4/T5a/T5b run in myclaw; the two audits already in this folder. Line numbers are from that branch.

## 1. Speed

Baseline for a 40–60-file task like T5a (59 files, +4,237).

| Mode | Wall-clock | Human touches | What dominates |
| --- | --- | --- | --- |
| (a) plan-and-implement, one review | 3–5 h | 1 plan read, 1 PR review | the build itself; the review catches whatever it catches once |
| (b) workflow as it stood on T5a | ~40 h elapsed, ~14 h active | 5 owner-question rounds, 2 board approvals, 11 degraded windows | 18 delegate runs, 9 stage-review rounds + 3 lens rounds, contract re-recording |
| (b') workflow after #189 + decisions 1–3 | 6–9 h | 1 bundled owner round, 1 approval | 1 contract + 2 grill rounds (~20 min), 3–6 delegate runs (4–14 min each), 2–3 review rounds (~12 min each), seal + PR |
| (c) with task-level parallelism, 3 tasks | 6–9 h per story instead of per task | same as (b') per story if questions are bundled per story | the slowest task's chain; merge order |

Where the numbers come from: delegate medians 4 min / p90 13.5 min are the harness's own ledger (the external audit's table matches what T5a's runs took); a three-lens `forge review` is three sequential Codex calls of 3–5 min each (`review.py:476-480` runs them one after another); a grill round is a 7–9 min Codex read.

What still dominates in (b') and is **ceremony, not accuracy**:

1. Three lens calls run sequentially per review round (`review.py` loops `for lens in lenses` and waits on each `process.wait()`). Running the three in parallel or as one bundled call is a ~10 min saving per round, 2–3 rounds per task. Nothing in accuracy depends on them being sequential.
2. The contract-authoring step (JIT contract + `task plan save` + grill record + board view + approve) is five commands and one Codex read before any code. Decision 3 (plan review records, not gates) removes the re-records; the board-view gate (`factory_lib.py:1677` `plan_was_viewed`) and the two `--by` approvals remain as pure touches.
3. The delegate is compact-404-prone above ~30 files per run, so a 55-file task is 3–4 sliced runs by construction, each with a 2-minute launch overhead. Plugin-side; the harness can only slice smarter.

What dominates and **is load-bearing**: the review rounds after fixes. Round 7 on T5a caught a bug that run 16's own fix introduced. That is the single strongest argument for the loop and it must stay.

Verdict on speed: (b') is 1.5–2× a good developer's plan-and-implement for one task, with the difference being the grill, the sealing and the sequential lenses. It becomes faster than a human only in (c), because the human's time per story stops scaling with the number of tasks.

## 2. Accuracy

Gates that caught defects plan-and-implement would have shipped:

- The hardFloor guard missing at the chat-side remembered-allow consult (T4: two P1s at the coordinator gate and both IPC branches; T5a: the job-projection branch). Found by the review, not by tests, because the tests pinned each branch separately and no test covered the shared predicate. `permission-decision-coordinator.ts` now guards each consumer.
- A card with no way to say No when the remembered denial is refused (T5a round 1 of the three-lens review). Copy-level defect no unit test asserted.
- "Remembered" receipt with nothing stored: trust growth offered without a usable tool-kind candidate (same round).
- Remember codes offered on refused candidates, the folder alternative surviving a count failure, the eligibility gate on persisted scalar affordances (stage rounds 6–7). Each was a real behaviour bug.

That is six real bugs in one task from the review lens, plus S4 in the tap-budget suite catching the review's own wrong fix. A single-pass review would have found the first round's items and none of the ones introduced by fixes.

Where the workflow LOWERED accuracy:

- The three-lens review, seeing only T5a's contract slice, demanded a hard-floor gate that the approved T3b-AC3 forbids, three rounds running; the first "fix" broke the story's S4 scenario and was caught only because S4 was a pinned test. #189's settled-contracts section and the rejection ledger address exactly this; the audit of #189 itself then spent three rounds on whether a citation can be proven relevant, which no digest can decide. Lesson: a reviewer without the story's decisions is a liability, and a reviewer that cannot be told "settled" loops.
- The stage-local review and the three-lens review judged the same diff with different briefs. Removed by #189.
- False positives cost real fixes: round 7's "trust-growth verdict" finding was a plan typo; a "write identities" finding was a false positive. Both were cheap to reject once, expensive when the harness had no way to record the rejection.

Net: accuracy is up, clearly, and the remaining accuracy risk is the reviewer arguing with settled decisions; #189's brief + reject + lessons is the right shape, and the human sees rejections in the PR body.

## 3. Cognitive load with parallel tasks

Today, per task, the human is asked for: the bundled owner questions before the first grill (good), a board view + approve (mechanical), and then nothing until the PR — provided the coordinator resolves signals. The coordinator resolves signals, not the human (`signal.py:194` pauses the worker for the orchestrator). So the interrupt profile for one task is already close to "questions up front, PR at the end".

With three tasks in parallel the multiplier is on the coordinator, not the human, IF three things hold:

1. **Owner questions are bundled per story, not per task.** Today the grill asks per task (`record_grill` requires `frontier_empty` per gate, `record_grill_from_json.py:122-131`). For a parallel story, the coordinator should collect the owner questions of all ready tasks into one round before any of them starts. Nothing in the harness prevents it; the `forge` skill should say it.
2. **Approvals collapse to one per story.** The board-view + `--by` gate per task (`plan_was_viewed`, `task approve`) is three touches for three tasks that the human cannot meaningfully distinguish. Decision 3 (plan review records) should extend to task plans: one story-level approval of the decomposition, task plans presented on one board page, no per-task approve. This is the biggest cognitive-load item.
3. **Merge order is decided by the dependency graph, not by the human.** `task_dependencies` / `ready_task_ids` exist (`factory_lib.py:2337-2364`); `task start` still gates on the list predecessor's marker (`tasks.py:266-270`) and `stage start` refuses a second active stage (`stages.py:950-955`). The parallelism PR must make the frontier the DAG and let the coordinator merge in ready order; the human only sees PRs.

Where a human would still be forced to arbitrate, and how to remove it:

- Two tasks touching the same area (a scope collision). Refuse at `task start` when declared areas overlap; the plan splits by area or the tasks serialise. Do not ask the human mid-run.
- A review finding on task B that contradicts a contract task A just sealed. The settled-contracts section covers it; the coordinator rejects with the citation. No human.
- A trunk merge of task A that breaks task B's verify. The coordinator merges trunk into B, re-verifies, re-reviews; the human sees nothing unless verify cannot be made green (then one question).

If those three hold, parallel tasks are self-driving and the human's load is one question round and one PR review per task, both asynchronous. If they do not hold, parallelism multiplies interrupts and Ravi's concern is exactly right.

## 4. Failure modes with 2–3 parallel task worktrees

Ordered by what breaks first.

1. **Companion lock.** Delegation locks live under each worktree's git control dir (`delegate.py:106-120`), and the companion is launched with `--cwd <worktree>` (`delegate.py:1086`). So two worktrees can hold two jobs. What is shared is the Codex account rate limit and the compact-404 behaviour under load; expect stalls to correlate. Behaviour wanted: the coordinator staggers launches and watches signals per worktree; no harness change.
2. **Ledger merges.** `.factory/stages.json` is one file per story (`stages.py:139`); two worktrees writing different stage records of the same file conflict on merge. Decision 0022 already moved lessons to one-record-per-file; stages need the same (audit item 3, L). Minimal design: `.factory/stories/<key>/stages/<task>.json`, `load_stages` composes them in decomposition order. Until then, parallel tasks that both close will conflict on the story merge; the per-task PR flow hides it (each PR carries its own stage record) but the story worktree merge does not.
3. **Trunk merge order.** Task B branched from trunk before task A merged; when A merges, B's review base must advance (`resolve_review_base` already does this, `review.py:147`) and B's verify must rerun on the merged tree. The seal binds `product_tree_digest`, so a trunk merge into B invalidates B's stamp: one extra review round per sibling merge. Acceptable; say it in the skill.
4. **Review base drift.** Covered by `resolve_review_base` for trunk merges; not covered when B merges A's branch directly (not trunk). Rule: siblings merge only through trunk.
5. **The frontier.** `forge next` reports one task; with two active stages it must list all ready tasks and their state. Plain rendering change.
6. **Per-task proof.** Fixed in #189 (reviews under `tasks/<id>/`); verify and tests were already per task.

Nothing here is a blocker; item 2 is the only one needing a data-shape change.

## 5. Verdict and the three changes that matter

**Conditional yes.** Accuracy: yes now. Speed: not on a single task; yes per story once tasks run in parallel with one owner round and one approval per story.

The three changes, in order of payoff:

1. **One owner round and one approval per story; task plans on one board page; no per-task approve.** Removes the only human touches that scale with task count. (M, harness: `task approve` becomes story-level once the decomposition is approved; `plan_was_viewed` keyed by story.)
2. **Task-level parallelism on the dependency graph with area-disjoint scopes, per-task stage record files, `forge next` listing all ready tasks.** This is where the speed comes from. (M+L as the audit sized it.)
3. **Run the three lenses concurrently (or as one bundled call) and slice delegates by area automatically from the write scope.** Cuts ~30 min per task of pure waiting. (S for the lenses; M for auto-slicing.)

Remove outright: the separate task-plan approval gate after the decomposition is approved (it is a second signature on the same design); the board-view requirement as a hard gate (make it a note); the exact-JUnit-title leaf ids (prefix match). Keep: verify.py as the single gate, pinned leaf tests, the review loop with settled contracts, per-task PRs, degraded windows for host-only fixes.

One warning: decision 2 (bounded coordinator fixes) is where accuracy can quietly leak. Keep the rule that a coordinator fix is reviewed by the same `forge review` before the seal; T5a's windows 1–6 were all reviewed, and round 7 caught one of them.

---

**Owner ruling after reading (Ravi, 2026-09-09):** the recommendation to move to one owner-question round and one approval per story is REJECTED. Developers cannot think a story through at story level; the owner questions that mattered on T5a and T5b only surfaced when each task's plan was written against the real code. Per-task planning, per-task cold grill, bundled per-task owner questions and one approval per task stay. The simplification that stands is narrower: drop the duplicate touches around them (the record-grill/approve/stage-start/record-again/approve-again recipe, the board-view hard gate, the plan-mode marker bridge).
