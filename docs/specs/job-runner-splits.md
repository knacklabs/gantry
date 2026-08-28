---
slug: job-runner-splits
title: Job runner: split runActiveJob and runQuery by phase
status: confirmed
saved: 2026-08-28T05:36:55+00:00
---

# Job runner: split runActiveJob and runQuery by phase

## Why

The cyclomatic-complexity review of PR #444 (Codex, 2026-08-27) named three giants; CHAN-2 (#451) retired the Telegram one. The two remaining are the job run loop and the SDK query loop: `runActiveJob` in `apps/core/src/jobs/execution.ts` (AST cyclomatic complexity 76, ~400 lines in an 848-line file) and `runQuery` in `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts` (CC 81, ~600 lines in a 770-line file). Every incident fix in the last two weeks (lease/heartbeat, notification, finish nudge, stream handling, permission waits) landed inside one of these two functions, and each was harder to review than it should have been because the whole phase sequence lives in one body. None of this is behaviour.

## Behaviour

Nothing a user or another module can observe changes. Each giant becomes a thin phase sequence that calls one named function per phase, with the shared per-run state carried in one context object built once:

- `runActiveJob` — setup/readiness, lease + heartbeat, prompt build, agent invocation, result handling, finalization/notification, cleanup — each a named function in a sibling module under `apps/core/src/jobs/`.
- `runQuery` — stream/session setup, per-message handling (assistant text, tool activity, permission waits, follow-ups/nudge), result branch, close/end — each a named function in a sibling module under `runner/`.

Pure moves: call sites move, existing helpers are not re-implemented; every existing unit and integration test passes unchanged (additions only).

## Acceptance criteria

- `runActiveJob` in jobs/execution.ts is split by phase into named functions in ONE sibling module, each with cyclomatic complexity <= 25, sequenced from a body whose own complexity is <= 15; no behaviour change.
- `runQuery` in runner/query-loop.ts is split by phase into named functions in ONE sibling module, each with cyclomatic complexity <= 25, driven from a loop body whose own complexity is <= 15; no behaviour change.
- No behaviour change: existing unit and Postgres integration tests pass unchanged (only new tests may be added); tsc, architecture check (map entries for the new modules), unit + Postgres integration lanes green.
- Branch based on main after PR #451 (CHAN-2).
