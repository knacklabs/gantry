---
name: legibility-plan-autoplan-review
description: "autoplan review outcome for the \"make gantry's agent legible\" plan (presence + decision prompts + job notifications + streaming)"
metadata: 
  node_type: memory
  type: project
  originSessionId: c437dd15-347f-4840-8340-6a7d28e338a3
---

The "Making gantry's agent legible" plan (presence/todo-card + intent-first permission DecisionCard + honest job notifications + streaming) was reviewed via /autoplan on 2026-06-25. User kept the locked "one release, four-channel parity" scope. Approved as-is. Plan file: `~/.claude/plans/users-ravikiranvemula-claude-uploads-01-vectorized-reddy.md` (carries full review + 34 tasks + GSTACK REVIEW REPORT). Test plan: `~/.gstack/projects/vrknetha-myclaw/vrknetha-main-test-plan-20260625.md`.

Key durable findings (CEO 6/6, Design 7/7, Eng 6/6, DX 6/6 cross-model consensus, code-grounded):
- **Part 1 should REUSE, not rebuild.** A wired 4-channel live-in-place todo card already exists on main: `AgentTodoSink` + `channels/agent-todo-render.ts` + {slack,telegram,discord,teams} todo deliveries + the bounded **display-only** `todo_update` MCP tool (1-50 items). Anthropic `TodoWrite` is already faced to `todo_update` (`gantry-tool-facades.ts:36`). So delete the proposed new `AgentPresence` projection + raw `write_todos` un-strip + net-new TodoWrite stream-parser; build only the gaps (durable card message-ref, host-verified terminal state, step-freshness, edit-coalescing, reaction ack).
- **Truth model (flagged all 4 phases):** card ✅/done must come from `LiveTurnState`/`runStatus`, NOT model todos (`todoUpdateHandler` renders model-claimed status verbatim today).
- **`[Retry now]` is a dead button** on all 4 channels (`execution-notifications.ts:46`; backend `schedulerRunNowHandler` exists at `ipc-scheduler-mutate-handlers.ts:320` but no channel wires it). Wire it or don't render it.
- **Ship Part 3 first, standalone** (status-formatting.ts:31 hardcodes `Completed:` on failures + 3 boilerplate lines; reuse `statusLabel()`). Existing tests assert the filler — update them.
- LiveTurnState has **8** states (plan said 6; missing `recovered`, `timed_out`). `progress-state-file.ts` is in `channels/` not `runtime/`. `summarizeBashCommandPrograms` already committed to main (6d9b8a3db), not "staged."

Related: [[runtime-prompt-guidance-source]] (OPERATING_GUIDANCE_BLOCK is the live voice-layer source), [[ipc-mcp-stdio-fixture-copy-list]], [[no-backward-compat]].
