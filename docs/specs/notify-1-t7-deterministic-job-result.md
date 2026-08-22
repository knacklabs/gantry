---
slug: notify-1-t7-deterministic-job-result
title: Deterministic structured job result from recorded run actions
status: confirmed
saved: 2026-08-21T08:12:47+00:00
---

# Spec: Deterministic structured job result from recorded run actions

## Why
A scheduled job's completion notification currently shows truncated agent
narration, so an operator cannot see what the run actually did (e.g. which leads
were written). We want the notification to carry a structured `result` describing
the run's real actions — capabilities executed, browser actions, denials —
derived deterministically from recorded run data, not from narration. A per-job
agent-called `job_report` tool was rejected: it does not scale and is not
deterministic. This is a platform-side projection over recorded actions.

## Behaviour
- On a scheduled `capability_run` success, the runtime records a run-scoped
  action (capability id + outcome + bounded summary), so the outcome is
  queryable at run completion. Argument capture is opt-in
  (`GANTRY_AUDIT_CAPABILITY_ARGS`) and redacted; secrets never leak.
- At completion, the runtime collects the run's recorded capability, browser, and
  denial actions and projects them to `StructuredJobResult.items` via a pure,
  deterministic function. Known capability ids get human labels via a thin
  semantic map (e.g. `google.sheets.values.update` becomes "Updated sheet");
  unknown ids fall back to a generic humanizer. Outcomes are `done` or `failed`.
- The structured `result` is attached to the job notification view when present.
  When no actions were recorded, no `result` is set and the neutral
  `fallbackText` is used. The formatter never branches on the agent runtime; the
  view stays bounded.

## Acceptance criteria
1. Scheduled `capability_run` success emits a run-scoped record queryable at
   completion; args opt-in gated and redacted.
2. `result.items` are projected deterministically from recorded capability,
   browser, and denial actions, with a thin semantic map plus generic fallback.
3. Neutral `fallbackText` is always produced; empty actions yield no result; the
   view stays bounded.
