---
slug: file-3-attachment-failure-diagnosability
title: FILE-3 attachment failure diagnosability
status: confirmed
saved: 2026-08-06T09:13:57+00:00
---

# FILE-3 — Attachment failures say which cause

Status: draft
Story: FILE-3
Trigger: a Gantry deployment reported `attachment_open` failing for every Slack
file and every file type with one sentence — "I can't get that file from the
channel right now." — and no way to tell why. Diagnosis validated by a
read-only Codex review (2026-08-06).

## Why (plain language)

When Gantry can't fetch a file, the person asking gets the same sentence no
matter what went wrong, and the operator gets no log line at all. A missing
Slack permission, a channel the bot isn't in, a timeout, and a dead internal
request all look identical. The reporter could not tell which of those they had,
and neither could we without reading source.

Worse, the one tool meant to catch this — `gantry provider doctor` — can report
green while the token is missing `files:read`, because a feature-scope warning
is dropped when two `ok` validations are folded into an unconditional pass.

## What is actually broken (validated, with evidence)

1. **Every distinct failure collapses into one message.** Slack API failures are
   normalised into an `unreachable` result rather than carried as a reason, and
   `ipc-attachment-open-handler.ts:83-96` converts a thrown `openAttachment`
   into a *successful* IPC envelope containing the generic copy. The user
   therefore cannot distinguish scope, membership, size, timeout or transport.
2. **No log exists for the common causes.** There is no attachment-open log for
   Slack `missing_scope`, 401/403/404, rate limiting, network failure,
   `not_visible`, `incapable` account/channel routing, missing `provider_fetch`,
   the ~110s resolver deadline, or the ~120s runner no-response timeout. Today
   the only discriminator is elapsed time, which is not a diagnostic.
3. **The provider doctor can pass while the scope is missing.** `files:read` is
   deliberately a feature scope, not a startup requirement
   (`cli/slack-install-scopes.ts`), but the doctor drops that warning
   (`cli/slack.ts:175-190`, `cli/model-credential-verify.ts:261-272`). A green
   doctor does not rule out the reported failure.

Not broken, checked: Slack downloads DO send `Authorization: Bearer <botToken>`
(`channels/slack/channel-state.ts:661`, `inbound-attachment-download.ts:32`).

## Locked product decisions (Ravi, 2026-08-06, in chat)

1. **Cause-specific, actionable copy.** The user sees what went wrong and what
   would fix it — e.g. "I can't read files in this workspace yet — the Slack app
   needs the files:read permission and a reinstall. Ask an admin to reinstall
   Gantry." — not a generic sentence or an opaque code.
2. **Scope: diagnosability + doctor honesty.** Per-cause logs, distinguishable
   failures, and a doctor that cannot hide a missing feature scope. The deeper
   IPC-boundary refactor (carrying a typed failure end to end instead of
   collapsing into a "successful" envelope) is NOT in this story.
3. **The doctor warns loudly; it does not fail.** A workspace that never shares
   files still passes, but the warning names the missing scope and the reinstall
   step and cannot be swallowed by an aggregate pass.

## Scope

### A. Name the cause to the user
- A single classification point maps each failure to a cause:
  `permission_scope`, `not_a_member` / `not_visible`, `deleted`, `too_large`,
  `rate_limited`, `timeout`, `transport`, `unknown`.
- Each cause has one plain-English sentence that says what happened and, where
  an action exists, what would fix it. Copy carries no stack traces, tokens,
  URLs or provider payloads.
- `unknown` keeps today's sentence — an unclassified failure must not claim a
  cause it does not have.

### B. Log the cause for operators
- Every classified failure logs once at warn with: cause, provider,
  providerAccountId, conversationJid, attachmentId, provider status code where
  there is one, and elapsed ms. No token, URL or file bytes.
- The three silent paths get logs they currently lack: the resolver deadline,
  the runner no-response timeout, and `incapable` routing.

### C. Honest doctor
- The Slack provider doctor surfaces missing feature scopes as a named warning
  that survives aggregation (the current unconditional pass drops it).
- The warning names `files:read` and the reinstall step, and points at the
  install doc. Absence of the scope does not fail the check (locked decision 3).

## Out of scope

- The IPC-boundary refactor that stops collapsing thrown failures into
  successful envelopes (locked decision 2) — file as a follow-up with a trigger.
- Changing Slack OAuth scope requirements or the install flow itself.
- Teams/Discord/Telegram-specific attachment causes beyond what the shared
  classification naturally covers.

## Success criteria

- Each cause in section A is reachable in a test and produces its own distinct
  user-visible sentence; `unknown` is the only path to the legacy copy.
- Each cause logs exactly once with the fields in section B; no secret material
  appears in any of them.
- A token without `files:read` produces a named doctor warning that survives
  aggregation, and the check still passes.
- The reporter's exact scenario (`files:read` missing, every file type) yields
  the permission sentence and one `permission_scope` log line.
