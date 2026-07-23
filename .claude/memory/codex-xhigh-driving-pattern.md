---
name: codex-xhigh-driving-pattern
description: How to drive codex exec xhigh implementation runs on this machine without losing work to timeouts
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4db9f26a-be43-4858-9370-cd7974ce934b
---

The user's implementation pipeline (updated 2026-07-10, codified in repo `.codex/skills/gantry-goal-pipeline/SKILL.md`): convert plans to a goal-prompt doc (format: `docs/architecture/*-goal-prompt.md`), then Claude orchestrates stage-by-stage implementation through the **codex plugin** — spawn `codex:codex-rescue` subagents, one stage per handoff, each prompt containing `--model gpt-5.6-sol --effort xhigh` (gpt-5.6-sol = current implementation model as of 2026-07-10; needs codex CLI >= 0.144.0 from npm — homebrew cask was uninstalled for lagging) (+ `--write` implied by fix requests; `--resume` to continue an unfinished stage, `--fresh` for a new one), `Use ponytail.`, `No commentary.`, `Return changed files, checks run, and blockers only.`, an instruction to delegate implementation edits to Codex subagents (repo config enables multi_agent, 8 threads; Codex main thread grounds/decomposes/reviews/verifies), plus bounded write scope. Claude verifies + commits between stages and closes with `python3 ~/.codex/skills/autoreview/scripts/autoreview --mode branch --base origin/main` repeated until clean (expect real bugs each round). Direct `codex exec -s workspace-write -c 'model_reasoning_effort="xhigh"'` via Bash is the fallback when the plugin is unavailable.

**Why:** codex xhigh routinely outlives the 10-minute Bash timeout; killed runs keep their work on disk and their session log intact.

**Wedge pattern (2026-07-10):** long xhigh runs (both gpt-5.5 and gpt-5.6-sol, both plugin-daemon and direct exec) can wedge mid-turn: 0% CPU, event log frozen. Detect via log-file mtime age > 10 min (source-file mtimes go quiet during legit thinking — watch the LOG, not the tree). Recover: kill the process / `codex-companion.mjs cancel <task-id>`, then `codex exec resume <session-id> --model gpt-5.6-sol ...` — CRITICAL: pass --model explicitly; resume silently defaults back to gpt-5.5 otherwise (it warns but proceeds). Session id is in the log header ("session id:"). Work + context survive; recovery is lossless.

**How to apply:** after a 143/timeout, either `codex exec resume --last "continue exactly where you left off" -c 'sandbox_mode="workspace-write"' -c 'model_reasoning_effort="xhigh"'` (note: resume takes `-c sandbox_mode=...`, NOT `-s`), or — often faster — check `git status`/tests directly: if the tree is complete and green, skip the resume. Gates to satisfy per stage: focused vitest dirs, `npm run typecheck`, `python3 .codex/scripts/check_task_completion.py` (file-size budgets — cli/model.ts limit 723; doc references must resolve from repo root; `ANTHROPIC_` literals outside adapter dirs trip the provider-boundary rule, including in tests). The pre-commit hook runs prettier --write and can leave reformatted files dirty AFTER the commit — check status and amend.
