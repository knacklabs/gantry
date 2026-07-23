# AGENTS.md — myclaw

## What This Repo Is

Symphony Forge is a dual-runtime software-factory template for turning in-repo architecture and decision docs into shipped applications.

It provides:
- planner-owned decomposition
- bounded implementation tasks
- deterministic verification
- schema-validated evidence recording
- autoreview-owned review
- PR-ready proof artifacts

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

Prompt files under `.agents/prompts/` are phase contracts. They are invoked explicitly by the parent session; hooks only load context and enforce gates.

Default specialist set:
- `planner-high`
- `docs-decomposer`
- `functional-checker` (user-facing tasks only)
- the autoreview skill (review — all three lenses, one run)

Testing has no separate agent: the implementer writes and records the tests.

## Reasoning Defaults

- planning / decomposition / architecture reconciliation: `high`
- code exploration: `gpt-5.6-terra` @ `high` (`/codex:rescue`, read-only)
- implementation: `gpt-5.6-sol` @ `medium` (`high` for migrations/cross-domain/security)
- review and testing agents: explicit per-agent overrides

Do not default the entire repo to `high` reasoning for every task.

## Deterministic Commands

Devs speak intents; the `/forge` skill maps them to these commands.
Lost? `./forge next` prints the current phase and exact next actions.

```bash
python3 .agents/scripts/intake.py --issue ENG-123 --title "Feature title"
python3 .agents/scripts/record_decomposition_from_json.py --input /tmp/decomposition.json
python3 .agents/scripts/update_run.py --phase awaiting-approval --plan-status awaiting-approval
python3 .agents/scripts/verify.py
python3 .agents/scripts/record_test_from_json.py --kind automated --input /tmp/automated.json
python3 .agents/scripts/record_review_from_json.py --aspect quality --input /tmp/quality.json
python3 .agents/scripts/pr_ready.py
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
- Evidence enters `.factory/` only via `record_*` scripts validating `.agents/schemas/` (pinned `generated_by`) — never hand-written.
- Review runs as ONE autoreview pass in Codex — never inline, never nested reviewers.
- Keep the template repo independent of any client-specific source repo.
- Do not keep long policy blocks in `AGENTS.md`; move them into docs.
- PRs: orchestrator may push story branches + raise PRs once `pr_ready` (one per story); merging stays human-gated; every PR body opens with the plain-language goal/why before the technical delta; runtime-behavior PRs carry their agent-e2e delta (or state why not). Policy: `docs/review-instructions.md`.
