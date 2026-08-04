---
name: goals
description: Report and maintain the ENGINEERING-GOAL status board (docs/architecture/goals-index.md). Use for goal/roadmap status ("where are we on the goals", "what goals are pending"), explicit /goals, when a goal stage ships, or when slotting a new goal. NOT for service health, jobs, PR, task, or runtime status. Three verbs — report, close, slot. Does NOT build goals (that is gantry-goal-pipeline).
---

# goals — cross-goal status tracker

The single source of truth is `docs/architecture/goals-index.md` (the board).
Session mechanics (Codex task ids, worktree paths, in-flight lane state) live in
the session-state scratchpad. **Never report status from memory — read the board
first, every time.**

Invariants (do not restate them — they live in AGENTS.md):
autoreview-before-every-commit · goal-pipeline-mandatory for builds ·
no session/URL trailers in gantry commits · durable status in the board,
ephemeral mechanics in the scratchpad (never duplicate — bug-family 1).

## report  (explicit `/goals`, or a goal/roadmap-status question — "where are we on the goals", "what goals are pending". NOT service/job/PR/runtime status.)

1. Read `docs/architecture/goals-index.md` (always). If the user named a goal:
   read its `*-goal-prompt.md` IF one exists; otherwise use the board's own
   `### <goal>` stage-detail block. Some goals (permission engine, Observer,
   capability authoring) are tracked only in the session scratchpad or have no
   committed goal-prompt — read the scratchpad and say where the source is.
   Never fail a report because a goal-prompt doc is absent.
2. For a general status / "what's pending" question, print the **Status board**
   table AND every pending section (Queued · Then · Parked · Roadmap · Ideation) —
   active goals alone omit model-management, media-render, prompt-driven flows,
   etc. If a goal was named, print its stage checklist + active-now + blocked-on.
3. Do NOT guess or fill from memory. If a status is stale/uncertain, say
   "verify" and reconcile against reality: `gh pr list --state merged --limit 80`
   (raise the limit — default is 30) + per-worktree `git -C <path> status --short`
   and its log (`git worktree list` alone only proves a worktree exists, not its
   dirty/merged state). Squash-merges make local ancestry unreliable — trust the
   merged-PR lookup.

## close <goal/stage>  (a stage merged)

1. Confirm it actually shipped — `gh pr view <NNN> --json state,mergedAt` shows
   `MERGED` (not bare `gh pr list`, which defaults to OPEN PRs).
2. In `goals-index.md`: tick that stage `[x] — #NNN`, then ALWAYS recompute that
   goal's board-table row (Progress, Active now, Blocked on) so a mid-goal stage
   (e.g. Observer S2) doesn't leave the row reading its old totals.
3. If the goal is now fully done, update BOTH structures atomically: (a) delete
   its board-table row, (b) delete its `### <goal>` stage-detail block, (c) add
   one line to the **Shipped** bullet list preserving ALL the goal's stage PRs
   (e.g. `- <goal> — #NNN/#MMM/…. \`<doc>\``), built from every completed stage —
   not just the final PR. Shipped is a bullet list, not a table — never leave a
   table row or an active checklist behind.
4. **Standing habit** — classify that cycle's review findings into the bug-pattern
   families; if a family recurs, note it and re-rank the board toward the
   simplification that retires it.
5. Drop the merged worktree from the session-state active-lanes list (the ONLY
   canonical home for live lane state). Do NOT hand-edit the board's Lane-hygiene
   snapshot per-close — it is a dated, regenerate-on-demand triage, not a
   maintained structure (regenerate from `git worktree list` + `gh pr list` when
   next needed).
6. Autoreview the doc diff, then commit.

## slot <goal-doc>  (queue a new/parked goal)

1. Read the goal-prompt's `Status:` line. If absent (most parked docs have none),
   infer real state from reality — merged PR (`gh pr list --state merged --limit 80`
   or `gh pr view <NNN> --json state,mergedAt`) + a per-worktree dirty check
   (`git -C <path> status --short`; `git worktree list` alone does NOT show
   dirtiness) — and CONFIRM the placement with the user before writing. Never
   slot an item that has no goal-prompt doc into a runnable (design-locked) queue;
   park it as unscoped until a goal-prompt + plan-validation exist.
2. If the goal is ACTIVE, add a row to the active Status-board table AND a
   `### <goal>` stage-detail block under **Active goals**. If it is QUEUED/parked,
   add it ONLY to the relevant section (Queued / Then / Parked) — NOT a table row
   (the board table is active-goals only; queued entries are authoritative in
   their own section and must not be duplicated in the table).
3. Record dependencies (what must merge first) as the blocked-on.
4. Autoreview + commit the doc.

## Checklist legend (matches the board)
`[x]` merged · `[~]` built, staged (not merged) · `[>]` in flight · `[ ]` pending.
