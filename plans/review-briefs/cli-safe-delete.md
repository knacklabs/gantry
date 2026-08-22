# Review brief — folder-safe agent-route removal + `gantry jobs delete`

Two bounded CLI fixes in `apps/core/src/cli`.

## Fix 1 — folder-safe agent removal (group.ts)
`gantry agent remove <route>` previously called `db.deleteSession(found.group.folder)`
unconditionally after deleting the route. `deleteSession(folder)` wipes **every**
session for that workspace folder (`deleteSessionsByWorkspaceFolder`). When several
routes share one folder (many routes point at `main_agent`), removing one route wiped
the shared agent's live sessions.

Fix: delete only the **removed route's own session**, scoped to its conversation
(`deleteSession(folder, threadId, {conversationJid, providerAccountId, conversationKind,
agentId})`). `resetScope` matches the exact scope key and every `::%` descendant, so
thread-variant sessions of that conversation are swept too. A folder shared by other
live routes is never touched, and there is no folder-wide wipe gated on a route count
that a concurrent write could invalidate — so it is race-free by construction.

**Deliberate non-goal:** no folder-wide "catch-all" wipe on the last route. That would
reintroduce a stale-count TOCTOU; per-route removal already clears each route's sessions,
and any session orphaned by a non-CLI route removal is harmless (unreachable, no route).

## Fix 2 — `gantry jobs delete <id> [--yes]` (jobs.ts, runtime-group-db.ts)
New subcommand mirroring `resumeJob`. Deletes one job via `runtime.ops.deleteJob(id)`
(the same method the scheduler's obsolete-dreaming-job reaper uses). Requires explicit
confirmation: `--yes`, else interactive confirm, else refuse in a non-interactive
terminal. Warns (but proceeds) when the id starts with `system:dreaming:` because those
are re-seeded from conversation routes unless the route is removed first.

## Scope / non-goals
Minimal diff, no refactors. Tests: folder-safe removal keeps sibling-folder sessions and
still wipes on last route; jobs delete refuses without `--yes` and deletes with the warning.
