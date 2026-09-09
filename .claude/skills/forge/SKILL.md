---
name: forge
description: >-
  Operate the Symphony Forge harness: start tasks, save approved plans,
  record decisions, assumptions, and client sign-off, harvest the
  docs/context inbox, check gate status, and review proposed skills. Invoke
  when the user says "start a task", "save this plan", "record a decision",
  "harvest context", "is this PR ready", "harness status", "what now",
  "create a new app", "set up a new project", "show me progress",
  "show the board", "review the plan", or "/forge".
---

Read `factory/skills/forge.md` and follow it exactly — it is the canonical
skill body shared by both runtimes. <!-- canon: factory/skills/forge.md -->

When the dev says "use lite mode", run `./forge mode lite`.

When the dev says "work the next task", follow decision 0032's JIT loop, one
task at a time, each its own PR:
1. author the next task contract against completed prior work (write_scope by
   AREA — directory prefixes plus named new files, never a file inventory),
   re-record the decomposition;
2. grill it cold (`--gate task`): bundle the owner questions up front, at most
   TWO rounds, fold the residue, record the pass;
3. `forge stage start <id>` then `forge delegate <id>`; a write delegation
   must never precede its fresh, passing task grill;
4. verify + record tests, commit, `forge review <id>` — the ONE three-lens
   review; a run with no P0/P1 finding stamps the stage. Blocking finding:
   `forge delegate <id>` the fix, commit, review again. A finding that
   contradicts an accepted decision / plan section / sealed contract:
   `forge review <id> --reject "<text>" --lens <l> --reason ... --cite ...
   --by ...` (it must resolve to something settled);
5. `forge stage done <id>` (strays, budget and test-id misses are recorded
   as NOTES, not refused; only >2x the line budget refuses), then
   `forge task pr-ready <id>`, poll CI, merge.
   Blockers found after stage done: `forge task reopen <id> --review-fix`
   (base, contract and approval stand), then step 4 again.

Parallel tasks: when `forge next` lists more than one task as ready ("also
ready in PARALLEL"), run each in its own worktree — grill and approve it in
the story worktree, `forge task start <id>`, then grill and `forge stage
start <id>` from inside that worktree — and watch each companion there. The
harness decides what may run side by side (dependencies done, write scopes
disjoint); a refusal names the sibling and the overlap, and the answer is to
re-plan the areas or wait for that stage, never to ask the human. Bundle the
owner questions of every ready task into one round before any of them starts.
Merge task PRs in dependency order; after a sibling merges, merge the trunk
into the open task worktrees, re-verify and re-review before sealing.
