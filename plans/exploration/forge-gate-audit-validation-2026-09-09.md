# External "Forge Gate Audit" — validated against symphony-forge main + #188/#189

Ravi supplied a gate audit written against another client (minegate, window Aug 22 – Sep 8, 2026) and asked for it to be validated, not trusted. Each of its twenty issues was checked against the harness code on `symphony-forge` main after #188 and the open #189, and against what this run (ASKFLOOR-1 T4/T5a/T5b) actually hit. Verdicts: **TRUE** (code confirms, still open), **FIXED** (closed by #188/#189 or an earlier upstream change), **PARTLY** (true in part or on an older harness), **WRONG** (the code says otherwise), **N/A** (not our platform).

## Its numbers

The per-task hours and the 70% "review of plans" figure are minegate's ledgers; I cannot verify them, but the shape matches ours: T5a took 18 delegate runs, 9 stage-review rounds and 3 lens rounds for a 59-file task, and T5b's grill ran 3 rounds with 30 findings, half of them file bookkeeping. The "1 : 25 build-to-process" ratio is the same story this run told.

## Issues, validated

| # | Audit issue | Verdict | Evidence | What we do |
|---|---|---|---|---|
| 1 | Plan reviews go stale on any tracked commit | PARTLY | `grounding_digest` (factory_lib.py:1961) includes the product tree only "before the stage opens" (`product_tree_sha256` when `treeish` is unset); once a stage is active the task grill is bound to plan + contract. Our T3b note confirms the pre-stage trap ("stamp → stage done with nothing between"). `docs/context/ledger.json` is in `WORKFLOW_PATHS` (stages.py:51), so hook writes do not stray the measure — but they do move HEAD before stage start. | Keep the fix small: exclude harness-owned paths from the pre-stage product-tree digest. S, new PR. |
| 2 | Plan reviewed twice per story (`saved:` timestamp in the digest) | TRUE | `plan save` writes `saved: <now>` into the frontmatter (plans.py:226); `plan_digest_without_assumptions` (factory_lib.py:1828) hashes the whole text minus the assumptions appendix, so the draft's grill can never match the saved copy. Our own ceremony memory says "grill recorded TWICE (source digest for save, active digest for approve)". | Hash the body without frontmatter (a `plan_body_digest` already exists at factory_lib.py:1835 for the post-tool hook). S, new PR; removes one record per story and the double-approve recipe. |
| 3 | write_scope strays at stage done | PARTLY | Refusal is real (stages.py:1024); T5a hit it with seven layering paths. But `docs/context/ledger.json` is excluded today, `stage amend-scope` exists and worked in one command, and #189 moves scope to area prefixes with the grill told not to audit file lists. | Already addressed by #188/#189 + amend-scope. Remaining: make decision records (`docs/decisions/`) never count as strays — they are in `HARNESS_PREFIXES` for review but not in `WORKFLOW_PATHS` for the measure. S, fold into the area-scope follow-up. |
| 4 | Review budget default 8 files / 400 lines; off-by-one refusals | TRUE | `DEFAULT_REVIEW_BUDGET_FILES = 8`, `_LINES = 400` (stages.py:77-78); `_measure` refuses over budget. Every real task of ours declared 40–55 files with a reason. | Owner decision 1 below (refuse vs record). My recommendation: record the overrun on the stage and the board, refuse only above 2× the declared budget. M. |
| 5 | Codex sandbox cannot run the verification | PARTLY | Plugin-side, not harness. In this repo the delegate runs the unit leaves fine after `npm ci` in the worktree; what fails is network installs and the Postgres lane. The harness mandates the sandbox as sole writer, which is the real coupling. | Owner decision 2 below. |
| 6 | Review findings have no channel back to the implementer | PARTLY | The brief DOES carry the lessons ledger (delegate.py:1038 `relevant_lessons`), and `forge delegate` runs inside an active stage — that is how every review fix reached Codex this run (17 lessons). The quickfix refusal (quickfix.py:110) is real but is not the fix path. Post-stage-done it WAS a dead end — fixed by #188. | Add the latest recorded blocking findings for the task to the brief automatically, so no hand-written lesson is needed. S, fold into the parallelism PR or its own. |
| 7 | Stage done demands a recorded Codex write launch | TRUE | `_require_successful_launch` (stages.py:1081); T4 needed a "confirmation" delegate run for exactly this. | Accept a ledgered degraded-window record as an alternative proof of who wrote. S. |
| 8 | Stage-local stamp not written by `forge review`; stale on any commit | FIXED | #189: a lens run with no blocking finding stamps the stage; `--task` selects the stage; pr-ready seals on it. | — |
| 9 | required_tests id must equal the JUnit testcase name | TRUE | stages.py:1286; our memory "leaf ids exact JUnit titles, no regex chars". | Prefix/tag match. S (audit item 7 of the Fable audit). |
| 10 | Frontier and marker gates (predecessor marker on origin) | TRUE (design) | `task_marker_on_main`; per-task PR flow. | Keep; the parallelism PR relaxes it to dependency order. |
| 11 | Seal freshness chain, three copies of `base_sha` | PARTLY | Stage `base_sha`, the git ref (`write_stage_ref`), story copy. #171 made reopen keep the base; `resolve_review_base` advances past trunk merges. Still three places. | Per-task stage record files (parallelism PR, L) collapse this. |
| 12 | `task reopen` re-baselines above the work → empty diff | FIXED | Upstream #171 (`test_reopen_keeps_base_and_stamp.py`) and #188's `--review-fix`. | — |
| 13 | A one-line fix needs a Codex launch | TRUE (design) | Session write lock (`pre_tool_use.py`); degraded windows are the 5-file escape. T5a used eleven. | Owner decision 2 below. |
| 14 | Mechanical human touches (board view, two approvals, question rounds) | TRUE | Board-view gate memory; the record+approve, stage start, record+approve recipe. | One grill record + one approval, `stage start` re-binds instead of staling. M (Fable audit item 5). |
| 15 | Two decomposition copies drift silently | WRONG on main | The recorder writes both copies in one go (record_decomposition_from_json.py:549-550); delegate and stage read the protected copy. A drift needs a hand edit of the story copy. | No change; the "ten reviewer-focus items never reached the implementer" case is more likely the reviewer_focus not being grounded (factory_lib.py:1945 says so on purpose). Fold reviewer_focus into the grounding digest? No — that re-stales on every wording change. Leave. |
| 16 | Requirements review has no scope; unexitable | PARTLY | `frontier_empty` is required; the cap was 5 and did not stop the loop. #189 sets the cap to 2 (then the human). Scope of the requirements grill is still the whole spec. | Scope the requirements brief to the story's roadmap slice. S, new PR. |
| 17 | Windows-only failures | N/A | macOS here. | Leave to the harness owners. |
| 18 | Small-refusal tax (outcome ≤ 800, required sections, `--base` ancestry) | TRUE | outcome.py:21 `MAX_CHARS = 800`; task-plan sections; decomposition objective ≤ 500 (we hit it). | Raise the caps to 2,000 and make missing sections a note, not a refusal. S. |
| 19 | PR open fails after the seal; no idempotent retry | TRUE | tasks.py:533 runs `gh pr create` once; no "already exists" handling. | If a PR for the branch exists, print it and succeed. S. |
| 20 | PR-contract gate sweeps other PRs' records; body edits don't re-trigger | TRUE | We hit it on #189 before #188 merged (`check_pr_ticket.py` counted Q-0123). | Count records by the PR's own commits (base = merge-base at check time); a re-run after the base moves passed. S. |

## Its root causes

- **A. Everything bound to bytes** — true, and it is the design; the cost is real when the harness's own writes move the bytes. The targeted fixes (2, 1, 11) remove the self-inflicted cases without dropping the binding.
- **B. Contracts guessed then enforced** — true for write_scope and budgets; #189's area scope answers the first, decision 1 answers the second.
- **C. Plan review is a gate** — true; decision 3 below.
- **D. One sandboxed writer** — true; decision 2 below.
- **E. Repair paths gated as hard as the gates** — was true; #188 (reopen), amend-scope, and #189's reject path close most of it; 19 remains.
- **F. Evidence ceremony** — true; items 8 (fixed), 14, 15 (wrong), 18, 20.

## What to take from it

Beyond what #188/#189 already do, the audit adds five cheap fixes worth a single follow-up PR: the plan-body digest (2), decision records never stray (3), degraded window as launch proof (7), idempotent PR open (19), the PR-contract base (20), plus the caps (18). Its four "decisions this forces" are real owner questions and are put to Ravi separately; the audit's own leaning (measure-and-report seals, a bounded coordinator writer, plan review as a review) matches what this run showed.
