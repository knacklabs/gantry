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

Prompt files under `.agents/prompts/` are explicit phase contracts.

They are used in three ways:
- `SessionStart` reports run state
- `PreToolUse` guards Bash commands at phase gates
- `Stop` emits a non-blocking reminder when implementation artifacts are incomplete
- the parent Codex session explicitly loads the relevant phase prompt before acting
- custom agents use their own `.codex/agents/*.toml` instructions as role-specific prompts

Hooks are not the workflow engine. They only add guardrails and continuation logic.

## Factory Phases

0a. `discovery` — lightweight problem, stakeholder, and constraint discovery. It does not require `.factory` ceremony.
0b. `prototype` — lightweight proof work before the factory loop. It does not require `.factory` ceremony.
1. `planning`
2. `decomposing`
3. `awaiting-approval`
4. `implementing`
5. `testing`
6. `reviewing`
7. `functional-check`
8. `pr-ready`
9. `done` or `blocked`

The sign-off gate sits between `prototype` and `planning`. `python3 .agents/scripts/record_signoff.py` records an accepted client sign-off decision by setting `client_signoff: true` in `.factory/run.json`.

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

Each leaf task must include:
- title
- objective
- doc references
- write scope
- dependencies
- acceptance criteria
- verify commands
- required tests
- reviewer focus

Store the decomposition in `.factory/decomposition.json` — that artifact is
canonical. Mirroring into a tracker (Linear, GitHub Issues, Jira) is optional;
`python3 .agents/scripts/render_linear_task_graph.py` renders a deterministic
Markdown view of the graph if you want one to review or sync.

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
