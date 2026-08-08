---
slug: caprule-1
title: CAPRULE-1 Scheduled runs use granted capability-backed commands; pause with one clear message
status: confirmed
saved: 2026-08-08T13:20:00+00:00
---

# CAPRULE-1 — Scheduled runs must use granted capability-backed commands, and pause with one clear message

## Problem

Observed live on the KnackLabs Lead Maintenance scheduled job:

1. A scheduled (autonomous) run is denied a command its agent is *granted* — both as a
   semantic capability (`google.sheets.values.get`) and as a concrete scoped rule
   (`RunCommand(/opt/homebrew/bin/gog sheets get *)`). The command matches the rule
   (verified), but the granted authority never reaches the scheduled permission
   decision, so the run pauses and the job never completes.
2. A single denied-tool pause emits three overlapping, jargon-heavy notifications with
   no actionable control.

## Intent

- A scheduled run can use exactly the capabilities/commands its agent has been granted
  through the host-reviewed authority path — no more, no less — so declared work
  actually runs. Ungranted capabilities still deny (no weakening of the PERM-2
  worker/host authority boundary: authority stays host-reviewed, never worker
  self-granted).
- When a run genuinely must pause for setup/permission, the owner gets exactly one
  plain-language message (and a one-tap approve when the denial is grantable), not a
  cluster of duplicate technical cards.

## Acceptance

- A scheduled run whose agent is granted a semantic capability (with its reviewed
  definition) can invoke the capability's command without denial; an ungranted
  capability still denies with a legible reason.
- Browser and other canonical capabilities keep working (regression).
- One denied-tool pause produces exactly one user-facing notification; no duplicate
  terminal card; copy is mobile-first plain language.

## Source

Live reproduction + two read-only code traces (root cause: the scheduled autonomous
rule set and/or host projection does not deliver the agent's reviewed capability +
command grants, and the terminal-run notifier double-renders alongside the setup card).
Belongs to the permission-engine epic (scheduled-run authority parity).
