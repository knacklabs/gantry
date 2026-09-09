# Symphony Forge workflow audit — 2026-09-09

One cold read of the whole workflow after harness PRs #188 (review-fix reopen, merged) and #189 (one review per task, settled contracts, rejection ledger, two-round grills; open with fixes on disk). Evidence is cited as `file:line` in `~/Workdir/symphony-forge` at the #189 head. Plain English for Ravi; the citations are for whoever implements.

## 1. Task-level parallelism inside a story

**Where it stands.** The pieces are half there. Tasks already carry a dependency DAG: `factory_lib.py:2337-2351` (`task_dependencies`: an explicit `dependencies` list, else the predecessor) and `ready_task_ids` at `:2356-2366` compute which pending tasks are ready. The decomposer prompt asks for `dependencies` (`factory/prompts/decomposer.md:98`). `forge next` prefers the earliest READY task (`factory_lib.py:2375-2410`). `task start` creates one branch and one sibling worktree per task from `origin/<trunk>` (`tasks.py:264-281`), so the worktree isolation exists. What is missing is that four gates still enforce **list order**, not DAG order:

1. `task start` refuses unless the *list predecessor's* marker is on trunk (`tasks.py:265-273`).
2. `stage start` refuses while any *earlier* stage is not done (`stages.py:899-903`) and refuses a second active stage outright (`stages.py:893-898`), and refuses `--parallel` by name (`stages.py:864-866`).
3. `stage done` requires "exactly one active stage" in the stamp recorder (`record_review_from_json.py:207-213`) and `stamp_stage_review` looks a stage up by id, which is fine.
4. `forge review` records lens artifacts at the **story** level: `evidence_path(base, story, "reviews/<lens>.json")` (`review.py:520-533`, `evidence_path` at `factory_lib.py:136-170`). Two tasks reviewing concurrently overwrite each other's artifacts, and even sequentially T5b's review erases T5a's. This is a defect today, not only a parallelism blocker.

**Ledgers and merges.** `.factory/stages.json` and `.factory/stories/<key>/stages.json` are single tracked JSON files; two task branches that each flip their own stage entry will merge cleanly only if git's line-level merge happens to keep both hunks apart — it usually does for distinct entries, but it is not guaranteed and there is no driver (`.gitattributes` registers `union` for legacy `.jsonl` only; decision 0022 moved lessons/quickfixes to one-file-per-record precisely to escape this). The task marker is already one file per task (`task_marker_path`), so the ship signal is merge-safe.

**Locks and the companion.** The delegation lock lives under the worktree's git control dir (`delegate.py:117-120`, `git_control_dir`), so two worktrees do not share it. The companion is launched with `--cwd <worktree>` (`delegate.py:1086`); the Codex plugin keys jobs by cwd, so two worktrees can run two jobs. One caveat observed this run: the plugin refuses a second launch while a *paused* job holds its lock — that is per cwd too.

**Minimum viable version (M).**
- `task start`: require markers for `task_dependencies(...)`, not the list predecessor (`tasks.py:265-273`).
- `stage start`: allow a second active stage when (a) every dependency's stage is done and (b) the new task's `write_scope` areas are disjoint from every active stage's effective scope (`_covered`/`effective_scope`, `stages.py:708-754`); drop the `--parallel` refusal. Keep sequential as the default when scopes overlap.
- Make review artifacts per task: write to `stories/<key>/tasks/<id>/reviews/<lens>.json` like `verify.json`/`tests.json` already are, and read them from there in `readiness`/`pr_ready` (`readiness.py:32`, `factory_lib.py:1234,1390`). This fixes the overwrite bug regardless of parallelism.
- Stamp recorder: select the stage by task id instead of "the one active stage" (`record_review_from_json.py:207-213`); `stamp_stage_review` already takes an id.
- `forge next`: report every ready task when more than one is ready ("2 tasks ready: T5b, T6 — start each in its own worktree").
- Stage tracker on trunk: keep one file, but write per-task stage records as separate files under `stories/<key>/stages/<id>.json` (same move 0022 made for ledgers) so parallel branches never touch the same file. This is the one L-sized piece; the rest is S/M.

**Risks.** Two tasks that both merge to trunk race on `plans/roadmap.json`'s `updated_at` and on the decomposition's `recorded_at`; both are already noise-prone (see the example-roadmap churn in #188). A task started in parallel whose contract cites another in-flight task's files is a plan error; the two-round grill must ask "does this task read anything the other active task writes?" Codex quota: two concurrent delegates double the burn.

## 2. The lifecycle as a state machine, after #188/#189

intake → sign-off → plan (save) → plan grill → approve → decomposition (skeleton, then frontier contract) → task grill → task-plan approve (board view) → task start (branch + worktree) → stage start → delegate → verify + tests → review (stamp) → stage done → pr-ready → PR → merge → next task.

Found:

- **Dead end fixed by #188, one remains.** After `stage done`, `task pr-ready` needs a fresh stamp (`_require_reviewed_commit`, `stages.py:825-852`). #188 reopens; #189 makes `forge review` produce the stamp. Remaining: `forge review` refuses a dirty product tree (`review.py:472-476`) and `stage done` refuses a dirty tree too — fine — but `forge review` also refuses when `verify.json`/`tests.json` are missing for the *story* (`review.py:481-486`), while those are recorded per *task* under `stories/<key>/tasks/<id>/`; `evidence_path` falls back through scoped → live → history, so this passes only because the first task's files exist. Check with a second task; if it fails, point the check at the task path.
- **Double gate: two approvals for one decision.** The task grill is recorded twice (once bound to the source digest for `plan save`, once to the plans/active digest for approve) and the task-plan approval needs a board view opened on that worktree (`board_views_path`, `factory_lib.py:1648-1690`). Every task this run paid: record + approve, stage start, record + approve again ("two-grill recipe"). Recommendation: one recording after the final grill, one approval, and let `stage start` re-bind the digest instead of staling the approval (M).
- **Plan-mode marker bridge.** Plan authoring must leave a plan-mode marker (`factory_lib.py:1839-1841`) even though authoring is mode-agnostic (decision 0050); in practice the coordinator touches and reverts plan mode to mint it. Drop the marker requirement or mint it from `plan save` (S).
- **Hand-written evidence.** Three artifacts are still authored by the coordinator from other tools' output: the stage-local stamp payload (gone with #189), the functional check (`record_test --kind functional`), and the tests artifact (`record_test --kind automated`, incl. `skills_used`). The last two should be generated from the leaf-run JUnit and the delegate's run record; today they are the largest source of "generated_by" fiction (M).
- **Scope amendment after the fact.** `stage done` measures scope at the end (`stages.py:1013-1030`); the coordinator learns about strays only then. With area-level scope this mostly disappears; still worth a `stage measure` dry run (S).
- **Ceremony that is pure bookkeeping:** exact JUnit leaf titles in the decomposition (`required_tests.id`), the design-skill attestation on text-only tasks, the `Ticket:` trailer dance for harness PRs. All S; see §5.

## 3. The #189 review design

- **Stamp from a clean run** (`stamp_stage_review`, `stages.py:803-834` in #189) binds task digest, brief digest, base and product-tree digest — the same binding the old manual stamp used, so `stage done`/`pr-ready` staleness checks still hold. Good.
- **`_score` floor** (`review.py:210-217`): a review with no P0/P1 can never score below 8, so `review_passed` (`readiness.py:32`) turns on blocking findings only. Correct given "P2 = follow-up"; note that the *quality* lens still turns `partial`/`missing` contract verdicts into a failed task-proof elsewhere (`_contract_verdicts`, `review.py:259-291`), which is the right place for that.
- **`--reject` gaming.** The on-disk fixes close the two real holes the autoreview found: `_review_set_problem` requires every lens recorded for this task (artifacts now carry `task_id`) against the current `branch_diff_digest` with nothing blocking before a stamp; `_cite_resolves` requires a decision id with a record file, a recorded contract id, or a story-plan `## ` header. Remaining gaps: (a) a plan-section citation is weak — any word in a header resolves (`S4`, `Risks`); require the section *body* to contain a keyword from the reason, or restrict to Decisions/rulings sections (S); (b) the rejected finding's lesson uses `area/**` from the finding's `area`, which is a directory string the reviewer chose — acceptable; (c) nothing stops rejecting the same finding class every task — the lessons ledger makes that visible, and `forge findings patterns` should count `rejected_findings` too (S); (d) the reject path does not check that the artifact's `branch_diff_digest` matches *before* moving the finding (it only checks before stamping), so a stale artifact can be edited — harmless, since it cannot stamp, but refuse early for clarity (S).
- **Too strict:** a single-lens run (`--lens quality`) never stamps (by design) but the hint should say so before the run, not after; and `_review_set_problem` demands all three lenses even for a docs-only task where performance/security are trivially clean — acceptable cost (~3 min).
- **`tasks.py` message**: the order on disk (fix, commit, review, stage done, pr-ready) is right.

## 4. Grilling

- The 2-round cap (`grill.py:228`) and area scope (`griller.md:216-223`, `decomposer.md:113-118`) are in #189. What still wastes rounds: (a) each round is a cold read of the *whole* plan and every cited file — a round-2 brief should carry round-1's findings and the fold, so the reader verifies the fold rather than re-deriving (the `test_grill_carries_answers` mechanism exists for AskUserQuestion answers; extend it to prior-round findings) (M); (b) `required_tests.id` must equal the JUnit testcase title verbatim (`stages.py` `_measure` → JUnit match), so the generator writes 100-character sentences that the implementer then has to reproduce exactly; match on a stable prefix or a test id tag (S); (c) the grill still asks the planner to name provider files the implementer will discover; with area scope the griller prompt now says so, but the *decomposer* prompt's "confirm required_tests paths" line still pushes enumeration (S).

## 5. Codex companion mechanics

| Cost this run | Where | Fix | Side |
| --- | --- | --- | --- |
| compact-404 stalls on large scopes (5 of 18 T5a runs) | plugin (`codex exec` compaction) | slice runs by area in the brief (`delegate.py` brief composer could emit "run N of M" sections from area scope) | plugin root cause; harness mitigation S |
| read-only grill forwarder returns no job id | `codex:rescue` subagent contract | return the job id / log path in the forwarder's final message | plugin S |
| delegate writes only in an active stage | `delegate.py:1273-1278` | fixed by #188 reopen | done |
| 5-file degraded windows for review fixes | `forge mode degraded` | no longer needed once `review → delegate` loop works; keep for outages | done by #188/#189 |
| design-skill attestation on text-only user-facing tasks | `record_test_from_json.py` / `record_review_from_json.py` via harness.yaml `required_skills` | let harness.yaml declare `text_only: true` per task or accept a `null_findings: [skill]` field the recorder validates | harness S |
| Sol account refusal → Terra pin via degraded windows | harness.yaml model pin | make the model a per-run override (`delegate --model`) so a pin is not a canon edit | harness S |

## 6. Top 10, prioritised

| # | Change | Effort | Where |
| --- | --- | --- | --- |
| 1 | Per-task review artifacts (`stories/<key>/tasks/<id>/reviews/`) + readiness reads them | M | fold into #189 (it touches the same recorder path) |
| 2 | `task start` / `stage start` gate on `task_dependencies`, allow disjoint-scope parallel stages, drop the `--parallel` refusal | M | new PR "task-level parallelism" |
| 3 | Per-task stage records (one file per stage) | L | same PR as 2, or follow-up |
| 4 | Stamp recorder selects the stage by task id | S | fold into #189 |
| 5 | One task grill record + one approval; `stage start` re-binds instead of staling | M | new PR |
| 6 | Round-2 grill brief carries round-1 findings and the fold | M | new PR |
| 7 | `required_tests.id` prefix/tag match instead of verbatim title | S | new PR |
| 8 | Generate tests/functional artifacts from JUnit + delegate records | M | new PR |
| 9 | `--reject`: refuse stale artifacts early; count rejections in `findings patterns`; tighten plan-section citations | S | fold into #189 |
| 10 | `delegate --model` override; `text_only` attestation | S | new PR |

Skipped on purpose: a custom merge driver for `stages.json` (0022 says split files instead), and any change to the story-level `roadmap parallel` (it works; the per-task version reuses its worktree recipe).
