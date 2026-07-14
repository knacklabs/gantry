---
name: gantry-goal-pipeline
description: Orchestrate a Gantry plan to a finished PR — Claude writes a goal-prompt doc, delegates implementation stages to the Codex plugin (xhigh + ponytail), verifies and commits between stages, and closes with the autoreview loop. Use when the user asks to implement a plan/goal prompt, "run the goal pipeline", "same as the goal", or hands over a docs/architecture/*-goal-prompt.md to execute.
---

# Gantry Goal Pipeline (Claude orchestrator)

Claude is the orchestrator: repo grounding, goal shaping, stage splitting, diff
inspection, verification, review triage, commits, PR closeout. Claude does not
implement directly — every implementation edit goes through the Codex plugin.
The codex-side twin of this contract is `.codex/skills/gantry-goal-pipeline/SKILL.md`.

## 1. Goal prompt

Convert the plan into `docs/architecture/<name>-goal-prompt.md` (copy the shape
of an existing one, e.g. `status-cost-cache-visibility-goal-prompt.md`):
objective, locked decisions, per-stage implementation shape, Surface Impact
Matrix, acceptance criteria, bounded write scope, focused verification, runtime
smoke, PR closeout.

Gate gotcha: every backticked file path must exist and resolve from repo root
(`check_task_completion.py` Active Doc References). For files a later stage
will create, write the bare basename plus prose ("new module in `apps/core/src/runtime/`").

## 2. Implementation handoffs

One handoff (stage) at a time — never two writers in the same worktree. Stage
size is bounded by packet separability (see §1), not serial run length —
Codex fans packets out to its subagents. For each stage, spawn an Agent with
`subagent_type: codex:codex-rescue` whose prompt contains:

- `--model gpt-5.6-sol --effort xhigh --fresh` on the first line (`--resume`
  instead of `--fresh` to continue an unfinished stage). `gpt-5.6-sol` is the
  current implementation model; it needs codex CLI >= 0.144.0 (npm
  `@openai/codex`, not homebrew). If a newer model ships, update this line.
- The stage scope, referencing the goal prompt file as the contract.
- The exact bounded write scope ("Nothing else").
- Repo gate notes: import from source modules in tests, no provider-name
  literals outside adapter dirs, file-size budgets.
- An instruction to use Codex subagents for implementation edits: the repo's
  `.codex/config.toml` enables `multi_agent` (8 threads). E.g.
  `Delegate implementation edits to your subagents with exact bounded write
  scopes; your main thread grounds the task, decomposes it, reviews subagent
  diffs, and runs the focused checks. Parallelize only clearly separable
  files/domains.`
- MANDATORY closing lines, verbatim in every implementation handoff:
  `Use ponytail. No commentary. Return changed files, checks run, and blockers only.`
  "No commentary" suppresses Codex's progress narration during generation —
  nobody watches the stream, so narration is wasted tokens and time; the only
  output that matters is the final changed-files/checks/blockers report.

The rescue agent usually starts Codex in the background and returns a
`task-...` id. Poll as orchestrator:

```bash
COMPANION=$(ls ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | tail -1)
node "$COMPANION" status <task-id>    # phase, elapsed, progress, log path
node "$COMPANION" result <task-id>    # final output once terminal
```

Arm a single-notification watcher instead of hand-polling:

```bash
until node "$COMPANION" status <task-id> | grep -qE '\| (completed|failed|error|cancelled) \|'; do sleep 20; done
```

## 3. Between stages (orchestrator duties)

1. Inspect the diff; reject overbuilt code — send the same agent a follow-up
   (or a `--resume` handoff) to trim rather than fixing by hand.
2. Run the smallest relevant checks: focused vitest files, `npm run build`,
   `python3 .codex/scripts/check_task_completion.py`.
3. Commit the stage. The pre-commit hook runs prettier and can leave
   reformatted files dirty AFTER the commit — check `git status`, amend.

## 4. Closeout

```bash
npm run build && npm test
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/check_task_completion.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/verify.py
python3 ~/.claude/skills/autoreview/scripts/autoreview --mode branch --base origin/main
```

Autoreview contract: accept only concrete findings grounded in current code;
fix accepted findings with the smallest diff (via a Codex handoff or directly
if trivial); rerun focused tests; rerun autoreview until clean. Expect real
bugs each round.

Runtime smoke: `npm run build`, `launchctl kickstart -k gui/$(id -u)/com.gantry`,
`gantry status`, then the Knacklabs lead-gen job to a successful terminal
result (`gantry jobs list/trigger/events`). Capture exact blockers — never
claim green without it.

PR: update the existing PR for the branch or create one; final pipeline
section carries implementation summary, verification evidence, smoke results,
autoreview clean result, remaining risks.
