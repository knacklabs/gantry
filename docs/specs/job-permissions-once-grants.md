---
slug: job-permissions-once-grants
title: Job permissions: one path, Allow for this run when nothing can be remembered
status: confirmed
saved: 2026-08-27T17:12:31+00:00
---

# Job permissions: one path, Allow for this run when nothing can be remembered

## Why

A scheduled-job run raises permission requests the same way chat does. JOBPERM-1 gave job runs a
single native card with exactly Allow / Deny, where Allow saves a rule so the next run does not ask
again. But a request that cannot become a saved rule — any tool, any command shape (a piped
command under decision 0134, an over-length input, a request with no rule suggestion) — never got a
card row: the host fell back to the old chat prompt, and the job-only option rewrite left that prompt
with a single Cancel button (live: run 0798f2bc, 2026-08-27 16:39Z, `permission_prompts` row
6299a039 rendered `["cancel"]`). The run sat on a question that could only be answered "no", and
nothing logged that the prompt went out.

Two prompt systems for one run is the defect. One path fixes the whole class.

## Behaviour

- Every permission request a scheduled-job run raises attaches to the job permission card as a
  need row. There is no classic-prompt fallback for job runs; if the card cannot be attached the
  request fails closed with a plain reason (never a chat prompt, never Cancel-only).
- Each need row carries a grant mode: `rule` (Allow saves a rule, as today) or `once` (nothing can
  be remembered; Allow applies to this run only). Mode is derived from whether the request has any
  persistable rule. Rows without a stored mode read as `rule`.
- `once` rows are identified by request id, so an earlier Allow never covers a later request or run.
- The card keeps exactly two buttons, Allow / Deny, for the whole card. A `once` row's copy names
  the command and says "(this run only)".
- On Allow, both modes re-check the deterministic rails; only `rule` writes rules. A `once` Allow
  replays a signed `allow_once` decision (decided by a human) to the waiting runner with no
  permission updates. Deny is unchanged.
- A `once` row whose waiter is gone (run ended, 24h expiry) settles visibly as expired; it never
  becomes durable authority and is re-asked on the next run.
- Pre-IPC rejections (remote-content commands, A-0066) are untouched: they never reach the card.
- Provider renderers, runner, heartbeat, and schema are unchanged.

## Acceptance criteria

- AC1: a job-run request with no persistable rule creates a `once` need row and a card revision with
  Allow / Deny; no classic prompt is sent and the job-only cancel-only option rewrite no longer
  exists.
- AC2: Allow on a `once` row replays a signed `allow_once` to the runner, writes no rule, and the
  held tool call resumes; Deny denies; the card settles and logs delivery as today.
- AC3: `rule` rows behave exactly as before (rule write + replay); existing rows without a mode read
  as `rule`.
- AC4: a job attach failure fails closed with a logged reason instead of falling through to the chat
  prompt.
