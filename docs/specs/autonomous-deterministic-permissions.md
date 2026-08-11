---
slug: autonomous-deterministic-permissions
title: Autonomous runs decide permissions deterministically
status: confirmed
saved: 2026-08-11T10:45:00+00:00
---

# Autonomous runs decide permissions deterministically — no classifier

**Status:** confirmed — Ravi, in chat, 2026-08-11 (classifier removed entirely from autonomous runs)
**Origin:** live incident 2026-08-11. The KnackLabs job paused at 08:53 with a
"needs send_message access" card; the identical call at 10:01 was allowed. Log
survey across all scheduled runs: `RunCommand` 45× allowed by `auto_classifier`
/ 15× cancelled; `send_message` 1× allowed / 1× cancelled. Same disease
CLIRUN-1 (decision 0120) cured for local-CLI capabilities, still live for every
other tool. The binding auto-mode contract is recorded in
[decision 0121](../decisions/0121-autodet-no-classifier-autonomous.md).

## Problem

On an autonomous (scheduled) run, a tool call that misses the deterministic
rule matcher falls through to the non-deterministic classifier. Decision 0115
makes an autonomous "ask" terminal, so the classifier's mood decides between
"run completes" and "job pauses with a buttonless card". A granted tool
(`mcp__gantry__send_message` is in the job's tool list) can still pause the job
because granted-tool state and the autonomous matcher disagree.

## Outcome

An autonomous run's permission decision is a pure function of its declared
grants. Same job, same call → same decision, every run.

1. **Classifier removed from the autonomous path.** Matched rule → allow.
   No match → terminal deny with the existing grantable pause card
   (SCHED-6/CAPRULE-1 machinery, unchanged). The classifier remains for
   interactive runs only, where a human can answer the ask.
2. **Granted means matched.** Any tool present in the job's effective allowed
   tools matches the autonomous matcher — the send_message
   granted-but-unmatched wart is impossible by construction.
3. **send_message destination rule.** Deterministic shape: sending to the run's
   own conversation/thread is allowed when the tool is granted; any other
   destination requires an explicitly declared destination grant, else terminal
   deny with card. No payload judgment.
4. **No silent degradation.** Terminal denies keep the one-notification pause
   card with the request_access recovery (existing behavior).

## Non-goals

- No change to interactive-run classification.
- No new grant UI; the existing card/grant flow is the recovery path.
- No revisiting 0115 (ask stays terminal on autonomous runs).
- RunCommand leaf-rule syntax unchanged; this fixes who decides, not rule shape.

## Acceptance

- Replay of the 08:53 send_message call under the new engine: allowed
  deterministically (own-thread) — no classifier invocation logged.
- A call to an ungranted tool on an autonomous run: terminal deny + card, no
  classifier invocation.
- Log/event assertion: `decidedBy=auto_classifier` never appears with a
  `jobId`-bearing run after cutover.
- Fix-and-continue: granting from the pause card resumes the job
  automatically; the re-run uses the grant and completes without re-asking.
  A pause is one interruption per genuinely missing tool, never a dead end.
