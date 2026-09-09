# Process simplification proposal — 2026-09-09

Ravi asked, mid T5a closeout: "some of this is overcomplicated — what can be simplified, is it grilling or gates?" This note answers from the T4/T5a/T5b evidence in this run, ranked by cost saved.

## What T5a actually cost

| Stage | Count | Notes |
| --- | --- | --- |
| Codex delegate runs | 18 | 5 died on the compact-404 stall, 2 refused by the Sol account, 1 read-only by accident (post-done) |
| Stage-local autoreview rounds | 8 | rounds 2–3 wasted (quota / wrong mode); 3 fix cycles; round-7 verdict finding rejected |
| Three-lens `forge review` rounds | 3+ | round 1 found one real bug and two contract violations; round 2 contradicted the approved T3b contract and the story's S4 ruling |
| Degraded windows | 11 | model pin, quota outage, and post-done review fixes (delegate cannot write after `stage done`) |
| Stage done attempts | 2 | scope amendment needed for review-cycle paths |
| Owner questions | 4 rounds | all bundled, all cheap |

T5b planning: 3 grill rounds, 30 blocking findings, write scope 35 → 46 → 53 → 55 files. About half the findings were "the plan cites the wrong file/line" or "this file is missing from the scope".

## 1. One review per task, not two (largest saving)

Today every task gets a stage-local autoreview loop (8 rounds here) AND a separate three-lens `forge review` of the same diff by the same engine. The second pass reads a narrower contract slice than the first and produced findings that contradict an approved decision (hard-floor gating vs T3b-AC3). Two reviewers with different context is not more safety; it is the same model arguing with itself.

Proposal: keep the three-lens review as THE review. Drop the stage-local stamp loop, or make the stage-local pass the three-lens pass (run it once at stage end with the plan slice and the contract union as input). Blocking = P1 only; P2 goes to the PR as follow-ups. Two fix cycles maximum, then the orchestrator reclassifies and ships (the autoreview skill's own scope governor).

## 2. A review-fix stage (the gate that fights itself)

`forge review` prints "delegate the fixes to Codex", but `forge delegate` only writes inside an active stage and `stage start` refuses a done task. Every post-review fix on T5a went through degraded windows, which exist for companion outages. Proposal: `forge stage start <task> --review-fix` (scope = the amended write scope, closed by `stage done` with the usual binding), or let delegate treat "review recorded with blocking findings on the task branch" as an active write context. (harness-proposals.md #19)

## 3. Reviews must carry the contract they judge against

The security lens rejected code that an approved contract requires because it never saw that contract (T3b's AC lives in another task's slice; the story ruling lives in the story plan). Proposal: the review brief includes the story plan's rulings section and the ACs of every merged task in the story, and a finding that contradicts a cited accepted contract is recorded as `rejected: contract` by the orchestrator without a fix cycle. Today there is no way to record a rejected finding at all, so the next round re-raises it.

## 4. Area-level write scope in plans

The T5b grill spent three rounds enumerating files; `stage amend-scope` exists precisely because enumeration is never right. Proposal: plans declare scope by area (`apps/core/src/application/permissions/**`, `channels/*/…`) plus named NEW files; the grill checks feasibility and contracts, not the file list; `stage done` measures and records the exact paths as it does now.

## 5. Grill budget: two rounds

Round 1 catches seam errors, round 2 catches the fold; round 3 on T5b produced residue only (locks, locale, a bounded key) that the implementer would have hit anyway. Keep the owner questions bundled up front (already the rule). Two rounds, then implement.

## 6. Smaller cuts

- Design-skill attestation on text-only tasks: `review-animations` is user-invocation only and the stamp recorder demands it; the FILE-3 null-finding ruling should be the recorder's default for tasks with no motion surface.
- Exact JUnit leaf titles in the decomposition: the generator already derives them; the human never edits them. Let `stage done` match on test id prefix.
- The forwarder for read-only grills returns "running in the background" without the job id, so every grill needs a hand-armed watcher on the plugin state dir. Return the job id.
- Board-view approval and the two-grill recipe (record + approve, stage start, record + approve) are pure ceremony once the plan is final; one approval after the last grill is enough.

## What to keep

verify.py as the single gate, pinned leaf tests, one PR per task with CI green before merge, sign-off before planning, and the owner-question bundles. Those are the gates that caught real bugs this run (S4 caught the review's own wrong fix).
