---
name: gantry-goal-pipeline
description: End-to-end Gantry plan implementation pipeline. Use when the user asks to implement or pursue a plan, goal prompt, feature, fix, refactor, PR update, or "same as the goal" workflow with subagent implementation, ponytail simplicity, no-commentary implementation, autoreview, build, launchctl restart, Knacklabs lead gen smoke, and PR/pipeline closeout.
---

# Gantry Goal Pipeline

Use this skill to turn a Gantry plan into a finished implementation with the
same discipline as the user's goal-prompt workflow: plan, implement through
subagents, verify, review, restart, smoke test, and publish.

## Core Rules

1. Load and follow `ponytail` before implementation. Prefer the smallest
   correct change, delete obsolete paths for single-cut work, and avoid
   compatibility shims unless the user explicitly asks for them.
2. Claude Code is the orchestrator. Implementation stages go through the
   Codex plugin (`codex:codex-rescue` → companion background task) at
   `--effort xhigh` with write access. The orchestrator owns repo grounding,
   plan/goal shaping, stage splitting, diff inspection, integration checks,
   review triage, commits, PR updates, and final reporting. The orchestrator
   does not implement directly.
3. Within a Codex task, use Codex subagents for implementation edits
   (`multi_agent` is enabled; up to 8 threads). The Codex main thread owns
   grounding, task decomposition, diff review of subagent output, and
   verification — it rejects overbuilt subagent diffs and runs the focused
   checks. Each subagent gets an exact bounded write scope and acceptance
   criteria; parallelize only clearly separable files/domains.
4. Every Codex implementation handoff must include:
   - `--model gpt-5.6-sol --effort xhigh` (and `--resume` to continue an
     unfinished stage; `--fresh` for a new stage). `gpt-5.6-sol` is the
     current implementation model (needs codex CLI >= 0.144.0); update here
     when a newer model ships.
   - `Use ponytail.`
   - `No commentary.`
   - `Return changed files, checks run, and blockers only.`
   - The exact bounded write scope and acceptance criteria (reference the
     goal prompt file when one exists).
5. If the Codex plugin is unavailable, stop before implementation and report
   that blocker. Do not implement directly under this skill.
6. Keep user-facing implementation commentary silent unless the user asks for
   status, a blocker needs a decision, or system instructions require a brief
   update. Subagents must not produce progress commentary.
7. Run `autoreview` as a required closeout loop after implementation. Fix only
   accepted/actionable findings, rerun focused checks, and rerun autoreview
   until clean.

## Plan To Goal Contract

For any non-trivial plan or feature:

1. Ground the plan in current repo truth:
   - Follow the repo `AGENTS.md` mandatory read order.
   - Run `python3 .codex/scripts/stage_orchestrator.py` when the plan overlaps
     an existing phase or goal prompt.
   - Read the relevant code, tests, schemas, and docs before trusting the plan.
2. Convert the plan into a goal prompt or update the existing goal prompt file
   when the user asks for a goal-style workflow.
3. Include acceptance criteria, bounded write scope, no-legacy cleanup terms,
   verification commands, runtime smoke steps, PR closeout requirements, and a
   Surface Impact Matrix.
4. Write each stage's implementation shape as separable work packets — one
   numbered item per ownership boundary (files/domain + its own acceptance
   criteria) — so implementation can fan the packets out to subagents
   immediately. Packets that share files must be merged into one packet;
   stage size is bounded by packet separability, not serial run length.
5. If the user says to pursue it as a goal, call the goal tool only when the
   current environment provides it and the user has explicitly asked for goal
   pursuit. Otherwise, treat the goal prompt as the execution contract.

## Implementation Workflow

1. Split work into stages by ownership boundary, each stage a set of
   separable packets that fan out to subagents in parallel — stage size is
   bounded by packet separability, not serial run length. If a run is cut off
   mid-stage, verify what landed, then continue the same stage with
   `--resume`. Prefer one handoff for a tight change.
2. Give each Codex handoff the exact files or surfaces it owns. Do not ask
   Codex to make product decisions.
3. Require Codex to use existing repo patterns and to keep diffs surgical.
4. After each handoff returns, the orchestrator must inspect the diff, reject
   overbuilt code, and run the smallest relevant checks.
5. For single-cut or no-legacy work, search for old active names, imports,
   table names, config keys, routes, docs, and tests before calling the cutover
   complete.

## Verification Pipeline

Choose focused checks first, then broaden based on risk. For substantial Gantry
changes, the default closeout pipeline is:

```bash
npm run build
npm test
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/check_task_completion.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/verify.py
```

Use disposable Postgres for DB-backed tests when required by repo instructions.
Do not use the developer's persistent database for tests that can run in a
disposable database.

## Auto Review Loop

Use the `autoreview` skill as part of this skill. When Claude Code
orchestrates, each review round is a codex rescue handoff that runs the
helper as ONE plain command (no shell wrapper, no env prefix, no chaining)
and returns findings verbatim (user decision 2026-07-11, confirmed working).
Enablers: `[sandbox_workspace_write] network_access=true` in the OPERATOR's
`~/.codex/config.toml` (user-level on purpose — repo config must not relax
egress) and an allow prefix_rule for the helper path in repo
`.codex/rules/default.rules`. The plugin's native `review` command is not
used.

Before starting a new review, check whether one is already running:

```bash
ps -ax -o pid,ppid,etime,command | rg 'autoreview|codex --ask-for-approval never --search exec|output-schema'
```

Run the helper appropriate to the state:

```bash
python3 /Users/ravikiranvemula/.codex/skills/autoreview/scripts/autoreview --mode local
```

For a committed branch or existing PR:

```bash
python3 /Users/ravikiranvemula/.codex/skills/autoreview/scripts/autoreview --mode branch --base origin/main
```

Contract:

- Accept only concrete findings grounded in current code.
- Reject speculative rewrites and fixes that overcomplicate the diff.
- If a finding is accepted, fix it with the smallest diff, rerun focused tests,
  then rerun autoreview.
- Stop only when autoreview exits clean with no accepted/actionable findings.

## Runtime Smoke

At the end of implementation, build and restart the local runtime from this
checkout:

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.gantry
launchctl print gui/$(id -u)/com.gantry
gantry status
```

If `gantry status` is stale or blocked, use the control socket health checks:

```bash
curl --unix-socket /Users/ravikiranvemula/gantry/run/control.sock http://localhost/healthz
curl --unix-socket /Users/ravikiranvemula/gantry/run/control.sock http://localhost/readyz
```

Run the Knacklabs lead gen smoke through the product runtime, not by editing DB
or settings directly:

```bash
gantry jobs list --limit 200
gantry jobs show <job_id>
gantry jobs trigger <job_id>
gantry jobs events <job_id> --full --limit 100
```

Find the job by id or name containing `knacklabs`, `knack`, or `lead`. The smoke
passes only when the job reaches a successful terminal result. If a real setup,
auth, capability, or external dependency blocks it, capture the exact blocker
and do not claim the runtime is fully working.

## PR And Pipeline Closeout

1. Re-check `git status` after hooks, formatting, and commits.
2. Commit only files intentionally changed for the goal. Do not stage unrelated
   dirty or untracked files.
3. Update the existing PR when one exists; create a new PR only when there is no
   existing PR for the branch.
4. If shell `git push` is blocked by local policy, use inspectable GitHub API
   branch-update steps instead of stopping.
5. Create a final pipeline section in the PR body or goal prompt with:
   - implementation summary;
   - single-cut/no-legacy cleanup evidence;
   - tests and verification commands;
   - build and launchctl/runtime evidence;
   - Knacklabs lead gen result;
   - autoreview command and clean result;
   - remaining blockers or risks.

Do not create a new CI system or extra pipeline framework unless the user
explicitly asks for that. The required "pipeline" is the closeout evidence path
that proves the implementation is done.
