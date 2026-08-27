---
slug: jobperm-1-chat-parity-job-permissions
title: Chat-parity permissions for scheduled jobs
status: confirmed
saved: 2026-08-23T11:15:17+00:00
---

# JOBPERM-1 — Chat-parity permissions for scheduled jobs

## Why

A scheduled run whose tool call matches no grant is cancelled by the autonomous
permission lane's instant hard-return (`permission-callback.ts:265-276`,
timeout 0) — even when the host would approve (Browser) or the user is one tap
away. Live evidence: "Needs permission" dead-ends on six days in two weeks; the
browser granted and prelaunched yet unreachable; `request_access` itself
denied; denial reasons carrying "Allowed by…" strings. The validated design
(`plans/review-briefs/scheduled-job-permission-parity-design.md`, v9 FROZEN,
seven adversarial Codex xhigh rounds) makes the no-match outcome an in-channel
ask that holds the tool call, persists on approve, and resumes in place — by
DELETING the parallel autonomous lane, not adding a third.

## Behaviour

- A grantable permission miss raises the standard approval card in the job's
  conversation ([Allow always for this job] [Deny] — no Allow-once), holds the
  tool call in the existing wait loop, and resumes in place on approve; the
  approval persists to the job (silent allow from then on).
- One living card per job (edits to a checklist, revision+epoch-bound
  [Allow all pending], capacity-aware), actor-authorised clicks (0118),
  confirmed-delivery-anchored 24h window, slot released while waiting,
  waiter-scoped handoff to a durable [Approve & run again] + [Deny] pause card.
- Hard-boundary shapes (remote-content-execution equivalence class) get a typed
  reformulation result; unprojected approvals land next run with a
  "Completed with limits" result and human [Run again now]; deny is per-need
  terminal with Reconsider; catalog makes requestable identities discoverable;
  denial texts are truthful. The v9 Deletions section is normative
  (single-cut: the old autonomous lane is removed).

## Acceptance criteria

- A scheduled run's unmatched grantable tool call raises the standard approval
  card and, on an authorised Allow, resumes the SAME run in place; the rule
  persists to the job and the next run silent-allows; unit + live test.
- Browser works for a granted job with no card (host verdict awaited);
  unit test.
- The living card coalesces needs (one card per job, revision/epoch-bound
  batch, no unseen approvals); provider contract tests (Telegram, Slack,
  Discord).
- Deny is terminal per need (typed truthful result, no re-ask across runs,
  Reconsider reopens a fresh epoch); handoff preserves [Deny] and requires the
  human [Approve & run again]; unit tests.
- Hard-boundary and unprojected cases produce the typed truthful results and
  never a permanent grant or auto-rerun; unit tests.
- The v9 Deletions land: the autonomous hard-returns, cancel branch, dead
  classifier-wait, dual auth/timeout rules are REMOVED (source assertions).
