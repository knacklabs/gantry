# FACTORY.md

## Purpose

This document is the operating contract for the factory beyond the short root `AGENTS.md`.

## Runtime

Claude Code coordinates (planning, decisions, orchestration via
codex-plugin-cc); Codex executes (exploration, implementation, testing, review
subagents, PR packaging). That two-runtime stack is deliberate and complete —
anything that ever drives sessions differently must still produce the
identical repo contract and `.factory` artifacts, which is the only rule that
matters here.

## Prompt Usage Model

Prompt files under `factory/prompts/` are explicit phase contracts.

They are used in three ways:
- `SessionStart` reports run state
- `PreToolUse` guards Bash commands at phase gates
- `Stop` emits a non-blocking reminder when implementation artifacts are incomplete
- the parent Codex session explicitly loads the relevant phase prompt before acting
- custom agents use their own `.codex/agents/*.toml` instructions as role-specific prompts

Hooks are not the workflow engine. They only add guardrails and continuation logic.

## Factory Phases

0a. `discovery` — lightweight problem, stakeholder, and constraint discovery. It does not require `.factory` ceremony.
0b. `prototype` — prototype freely and save capability specs as they emerge. It does not require `.factory` ceremony.
0c. `roadmap` — confirm every spec, then derive epics and stories from them.
1. `planning`
2. `decomposing`
3. `awaiting-approval`
4. `implementing`
5. `testing`
6. `reviewing`
7. `functional-check`
8. `pr-ready`
9. `done` or `blocked`

The sign-off gate sits between roadmap derivation and planning, and fires ONCE
for the project. `record_signoff.py` requires at least one confirmed spec, a
derived roadmap with at least one story, and coverage of every confirmed spec.
It then pins that record in `harness.yaml` (`signoff_record:`); the gate is
derived from that committed pin rather than stored in `.factory/run.json`.

Phases at `planning` or later are refused by `update_run.py` and `pre_tool_use.py` until `client_signoff` is true.

## Recommended Specialist Set

Minimum set for a production run:
- `planner-high`
- `docs-decomposer`
- `functional-checker` (user-facing tasks only)
- the autoreview skill (one run, three review lenses)

The implementer writes, runs, and records the automated tests — there is no
separate tester agent. This is enough for planning, decomposition,
implementation support, testing, and isolated review. Add more agents only
when the repo has a repeated bottleneck that justifies another role.

## Reasoning Matrix

Use strong reasoning selectively.

- planner / decomposer / architecture reconciler
  - model: `gpt-5.5`
  - reasoning: `high`
- code exploration (planning phase)
  - model: `gpt-5.6-terra`
  - reasoning: `high`
  - via `/codex:rescue --model gpt-5.6-terra --effort high` (read-only by default) — Claude Code never explores application code itself; raw `codex exec` is hook-blocked, no exceptions
- implementation default
  - model: `gpt-5.6-sol`
  - reasoning: `medium`
- implementation escalation cases
  - model: `gpt-5.6-sol`
  - reasoning: `high`
  - use only for migrations, cross-domain refactors, concurrency, security-sensitive work, or ambiguous failure modes
- review (autoreview run)
  - model: `gpt-5.5`
  - reasoning: `high`
- functional checker
  - model: `gpt-5.5`
  - reasoning: `high`

Defaulting all work to `high` is a bad tradeoff for cost, latency, and focus.

## In-Repo Docs Contract

The generated application repo is self-contained.

Put source material directly in:
- `docs/product/BRIEF.md`
- `docs/architecture/`
- `docs/decisions/`

Use:
- `docs/product/README.md` for the product brief contract
- `docs/architecture/README.md` for the architecture doc contract
- `docs/decisions/README.md` for the decision record contract

Optional supporting docs can live in:
- `plans/`
- `docs/product/`
- `docs/operations/`

Planning and decomposition should read only the in-repo docs, not an external source repo path.

## Decomposition Rules

The planner owns decomposition.

Decompose by:
- capability
- runtime seam
- data boundary
- vertical slice

Do not decompose by:
- markdown file
- ADR count
- arbitrary file count
- implementation agent convenience

The first decomposition records the ordered task list. Each leaf initially
includes:
- id
- title
- objective
- non-empty acceptance criteria
- dependencies when needed; every dependency names an earlier task

Immediately before the next pending leaf, enter plan mode per
`factory/prompts/planner.md` and author its execution contract against the
state left by completed tasks: write scope, exact acceptance criteria, verify
commands, required tests, and reviewer focus. Re-record the decomposition,
pass the digest-bound task grill, run `forge stage start <id>`, then
`forge delegate <id>`. Do not guess later-task execution detail. `forge next`
routes this loop one action at a time.

Store the decomposition in `.factory/decomposition.json` — that artifact is
canonical. Mirroring into a tracker (Linear, GitHub Issues, Jira) is optional.
Order is derived, never authored (decision 0021): the array is the execution
sequence and a task's `dependencies` may only name an earlier task.

## AGENTS Hygiene

Root `AGENTS.md` should stay near 100 lines.

Mechanically enforce:
- size cap
- required headings
- linked-doc existence
- no large duplicated policy blocks

Maintenance cadence:
- per PR: lint AGENTS and docs links
- weekly: stale rule scan
- monthly: compact overgrown instructions
