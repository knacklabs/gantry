# AGENTS.md — myclaw

## What This Repo Is

Symphony Forge is a dual-runtime software-factory template for turning in-repo architecture and decision docs into shipped applications.

It provides: planner-owned decomposition, bounded implementation tasks, deterministic verification, schema-validated evidence recording, autoreview-owned review, and PR-ready proof artifacts.

`AGENTS.md` stays short on purpose. Use it as a map.

## Mandatory Read Order

1. `WORKFLOW.md`
2. `docs/FACTORY.md`
3. `docs/QUALITY.md` and `docs/ROLES.md`
4. `harness.yaml`
5. `constitution/README.md`
6. `docs/product/BRIEF.md`
7. `docs/architecture/`
8. active decisions — `./forge decision list --active`, not raw `docs/decisions/`
9. the active plan and decomposition artifacts under `.factory/`

## Runtime Modes

Claude Code coordinates discovery, planning, decisions, and orchestration through `codex-plugin-cc`. During planning, codebase exploration is delegated to Codex read-only runs.

Codex executes exploration, implementation, testing, and review. The `.factory` artifacts are required regardless of how sessions are orchestrated.

## Phase Contract

0a. run lightweight discovery without `.factory` ceremony
0b. build a lightweight prototype without `.factory` ceremony
1. record client sign-off before planning
2. create or update the plan
3. generate decomposition
4. wait for approval
5. implement one bounded task (the implementer writes and records the tests)
6. run deterministic verify
7. run one autoreview pass (three lenses: quality, performance, security)
8. run the functional check when the decomposition says `user_facing: true`
9. mark PR ready

Phases at `planning` or later are refused until `client_signoff` is true in `.factory/run.json`.
Implementation never starts before plan approval and recorded decomposition.

## Prompt and Agent Use

Prompt files under `factory/prompts/` are phase contracts. They are invoked explicitly by the parent session; hooks only load context and enforce gates.

Default specialist set:
- `planner-high`
- `docs-decomposer`
- `functional-checker` (user-facing tasks only)
- the autoreview skill (review — all three lenses, one run)

Testing has no separate agent: the implementer writes and records the tests.

## Reasoning Defaults

- planning / decomposition / architecture reconciliation: `high`
- code exploration: `gpt-5.6-sol` @ `low` (`/codex:rescue`, read-only)
- implementation: `gpt-5.6-sol` @ `medium` (raise for migrations/cross-domain/security)
- review and testing agents: explicit per-agent overrides

Do not default the entire repo to `high` reasoning for every task.

## Deterministic Commands

Devs speak intents; the `/forge` skill maps them to these commands.
Lost? `./forge next` prints the current phase and exact next actions.

```bash
python3 factory/scripts/intake.py --issue ENG-123 --title "Feature title"
python3 factory/scripts/record_decomposition_from_json.py --input /tmp/decomposition.json
python3 factory/scripts/update_run.py --phase awaiting-approval --plan-status awaiting-approval
python3 factory/scripts/verify.py
python3 factory/scripts/record_test_from_json.py --kind automated --input /tmp/automated.json
python3 factory/scripts/record_review_from_json.py --aspect quality --input /tmp/quality.json
python3 factory/scripts/pr_ready.py
```

## Hard Gates

A task is not PR-ready until all of these exist:
- approved plan
- `.factory/run.json`
- `.factory/decomposition.json`
- `.factory/verify.json`
- `.factory/tests.json`
- `.factory/reviews/quality.json`
- `.factory/reviews/performance.json`
- `.factory/reviews/security.json`

## Non-Negotiables

- Keep tasks bounded and capability-driven.
- Do not decompose by document file or arbitrary file count.
- Do not bypass `verify.py` with ad hoc validation commands.
- Evidence enters `.factory/` only via `record_*` scripts validating `factory/schemas/` (pinned `generated_by`) — never hand-written.
- Review runs as ONE autoreview pass — never inline, never nested reviewers — by invoking the autoreview SKILL HELPER directly (`"$AUTOREVIEW" --mode branch|commit|local`; it spawns the Codex engine in an isolated sandbox, definitive exit code). NEVER a `/codex:rescue`/companion `review` job (hangs at finalization). Applies to per-stage LOCAL autoreview and PR closeout.
- Keep the template repo independent of any client-specific source repo.
- Scheduled jobs stage and execute at the group/channel (conversation) level; a topic/thread is delivery-only and must NEVER decide or block execution. Decision: `docs/decisions/`.
- Do not keep long policy blocks in `AGENTS.md`; move them into docs.
- Talk to the human in plain, everyday English; precision belongs in commits, decisions and PR bodies. Policy: `docs/communication-style.md`.
- PRs: one per TASK — `./forge task start <id>` cuts the task branch + sibling worktree from trunk, `./forge task pr-ready <id>` seals it and opens its PR after `stage done`; merge before the next task starts, never a whole story in one PR (WORKFLOW.md "Per-task PRs are the standard"); merging stays human-gated; every PR body opens with the plain-language goal/why before the technical delta; runtime-behavior PRs carry their agent-e2e delta (or state why not). Policy: `docs/review-instructions.md`.

<!-- forge:begin -->
<!-- Generated by forge sync. Edit outside the forge:begin and forge:end lines; sync rewrites this block. -->
## Working here with Forge

Forge takes each change from an approved plan to a merged pull request. Whenever you
are unsure, run `forge next`: it says where things stand and gives the exact next command.

If Forge started you with a brief, as a worker or a cold reader, that brief is your job: follow it
and the Rules below, and leave the flow and the approval steps to the agent coordinating the work.

### The flow

1. A story starts as one short doc: `forge story new <KEY> "<title>"`.
2. It gets one cold read (`forge read <KEY>`) and one approval from the human.
3. Each task runs in its own branch and worktree: `forge task start <KEY>/<TASK>`, then
   `forge work <KEY>/<TASK>`.
4. `forge close <item>` closes it when the tests pass and the review finds no serious problem.
5. The human merges. After the story's last merge, `forge story done <KEY> "<outcome>"`.

### The lanes

- **Story:** anything that changes an interface or needs more than five code files.
- **Fix:** a small change, started with `forge fix start "<why>" --done "<done when>"`.
  Specs, decisions, the roadmap and discovery notes ship as fixes.

### Rules

- Never commit to the default branch. Work happens on a story, task or fix branch, and the
  git hooks refuse anything else.
- Never merge a pull request and never use `--no-verify`. Merging is the human's call.
- Ask the human only to approve a story, to choose between options, or to merge.
- No running commentary. Speak only when something lands, when a failure or finding needs the
  human, or when a decision is theirs, in a line or two.
- Write for humans in plain English: no IDs, hashes or jargon in questions, pull request
  summaries or the board.
- A story is approved through Plan Mode: exit Plan Mode with the text of the story doc that
  `forge next` names, unchanged, as the plan. The approval matches its "What changes for you" and
  "Done when" sections exactly, so a summary or a rewrite records nothing. There is no other
  approval step.
- Run long `forge work` runs in the background and keep watching them.
<!-- forge:end -->
