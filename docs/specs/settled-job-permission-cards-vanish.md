---
slug: settled-job-permission-cards-vanish
title: Settled job permission cards disappear like chat prompts
status: confirmed
saved: 2026-08-28T12:36:28+00:00
---

# Settled job permission cards disappear like chat prompts

## Why

When a chat permission prompt is approved, the message goes away: Telegram, Discord and Slack delete it (with a receipt edit only if the delete fails); Teams, whose bot messages cannot be deleted, edits it to a receipt card. The job permission card (JOBPERM-1/2) never does: when its last row is answered it edits itself to "All permission requests for this job are settled." and stays in the group — a stale message per run with "this run only" rows (owner feedback 2026-08-28: "these one-time permission messages stick around; they should disappear like in chat").

## Behaviour

- A job permission card whose rows are all settled by **Allow** disappears the way an approved chat prompt does on that provider: deleted on Telegram, Discord and Slack; edited to a one-line receipt card on Teams. If a delete fails, the provider falls back to the receipt edit (as chat does).
- A card with at least one **denied or expired** row is not deleted: it is edited to a one-line receipt naming what the job did not get (e.g. "Permission denied: Run Command: curl …" / "Expired: …"), on every provider.
- Rule rows, once rows and expired rows behave the same way at retire time; nothing changes while the card still has an open row.
- Durable delivery semantics stay: the retire outcome is recorded on the revision, retries are idempotent (a deleted message is not re-deleted; a failed delete degrades to the receipt edit once).

## Acceptance criteria

- AC1: when every row of a job permission card is settled by Allow, the card message is deleted on Telegram, Discord and Slack and edited to a one-line approved receipt on Teams; a failed delete falls back to the receipt edit.
- AC2: when any row is denied or expired, the card is edited to a one-line receipt naming the denied/expired request(s) on every provider — never deleted.
- AC3: the retire outcome (`allowed` | `denied`) is carried on the card revision by the shared projection; provider deliveries act on it; recovery/retry of a retire revision is idempotent.
- AC4: existing unit and Postgres integration suites pass (only new or updated assertions on the retire text/operation); tsc, architecture check green.
