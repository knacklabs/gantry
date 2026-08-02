---
status: accepted
confirmed_by: "vrknetha"
date: 2026-07-24
---

# Inbound Attachment Descriptor Writer

## Context

The 2026-07-24 audit found (High) that Telegram and Slack inbound attachment
writes reach `<workspace>/attachments/<filename>` via `writeFile` / `open(...,
'w')` (`channels/telegram-file-download.ts`, `channels/slack/
attachment-download.ts` → `shared/private-fs.ts`), which follow a pre-planted
symlink or lose a check/open race — letting a malicious workspace overwrite
service-account-writable files outside the workspace. The hardened
`apps/core/src/platform/workspace-message-attachment.ts` is a read-only resolver: it proves
the descriptor-containment pattern but offers no write path.

## Decision

Build ONE shared hardened inbound-attachment writer (alongside
`apps/core/src/shared/private-fs.ts`) and route every inbound channel through
it: open a collision-resistant temp name with `O_CREAT|O_EXCL|O_NOFOLLOW`
inside a containment-verified directory, validate the opened descriptor
(fstat, containment), stream into the descriptor, then publish atomically
without replacing an existing target. Both the temp and the final file are
created **relative to a pinned directory descriptor** (Linux via
`/proc/self/fd/<dirfd>`; Darwin `O_NOFOLLOW_ANY` covers all components) so an
ancestor-directory swap after validation cannot retarget the write outside the
workspace. Raw `writeFile`/`'w'` inbound paths are deleted. Adversarial tests
run against the real filesystem — no fs mocks.

**Naming (locked 2026-07-24 after autoreview + user confirmation):** callers
allocate an **immutable, unique storage name** per attachment (e.g.
`attachments/<short-id>-<sanitized-name>`) and keep the original filename only
as display metadata. This is the sanctioned alternative named below; it makes
collisions impossible, so no-replace publication never drops a legitimate
re-upload of a same-named file.

## Consequences

- One writer closes the class for all current and future inbound channels;
  per-channel patches were rejected as leaving the class open.
- Attachments are stored under unique generated refs; the original filename is
  metadata. Same-named re-uploads each get a distinct storage ref (no silent
  overwrite of the earlier file, no silent drop of the newer one).
- **Publish primitive + portability ceiling (autoreview-locked 2026-07-24):**
  publication is `write-temp → rename(temp → final)`. Node exposes no
  `linkat(AT_SYMLINK_FOLLOW)` (path `link` on `/proc/self/fd` yields `EXDEV`)
  and no `renameat2(RENAME_NOREPLACE)`, so a filesystem-level *inode-bound,
  no-replace* publish is not achievable in portable Node without a native
  binding. The guarantees are instead delivered by: (1) **Linux (the
  production/fleet runtime — `node:24-bookworm-slim`; the prod gate rejects
  non-sandbox `direct` mode)** both `rename` operands resolve through the
  validated directory descriptor (`/proc/self/fd/<dirfd>/<name>`), so nothing
  can escape the workspace — the audit's "overwrite files OUTSIDE the
  workspace" is fully closed; (2) **no-replace** is delivered by 128-bit random
  storage IDs (a legitimate collision is impossible; forcing a `rename` replace
  requires predicting the random final name); (3) **Darwin (developer laptops
  only)** publication is path-based (no `*at` primitives), so an ancestor-swap
  race is bounded by the unpredictable random temp/final names plus directory
  descriptor validation. A native-binding Darwin hardening is deferred (see the
  deferral ledger) and gated on Darwin ever becoming a production runtime.
- Real-fs test coverage: pre-existing final-file symlink, swap-during-open,
  ancestor-directory swap, buffered + streaming paths.
