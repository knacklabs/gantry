---
id: 0111
title: One attachment-open timeout warning, deduped per shared operation
status: proposed
date: 2026-08-06
---

## Context

`AttachmentResolver.open` coalesces concurrent opens of the same attachment onto
a single in-flight fetch, and retries once when the row moves to a new provider
identity mid-fetch (stale retry F1 -> F2). Each caller also runs its own
deadline; when it fires we log one `cause: 'timeout'` diagnostic so an operator
sees exactly one warning per stuck open — not zero, not several.

Reaching that guarantee took several attempts, each pinning the invariant to the
wrong identity:

1. A bare null runner response was mislabelled as a timeout.
2. Dedup state lived on the flight object; a stale retry F1 -> F2 gave the two
   flights different cells, so a waiter still pointing at F1 double-logged.
3. Threading one shared cell down the call chain fixed the split, but a stale
   retry whose chain *joins* an F2 flight another opener already created left the
   two chains on different cells again.
4. "Only the flight's creator logs" assumed the owner's deadline fires first.
   It does not: an older F1 chain can, after a slow pre-flight, join a *younger*
   F2 owner's flight. The older joiner then expires first, stays silent as a
   non-owner, and if the shared fetch resolves before the younger owner's later
   deadline, **no** timeout is logged at all.

The recurrence is the signal: "one shared open" is not "one flight object" and is
not "one owner." It is one logical operation on an attachment identity, which can
span multiple flights and multiple concurrent callers.

## Decision

Deduplicate timeout logging in a **resolver-scoped registry keyed by the open
input** — `attachmentId \0 conversationJid \0 providerAccountId \0 mode` — not by
flight object, shared cell, or ownership. The key is stable across F1 -> F2
stale retries and across joins, and every concurrent caller of the same
attachment+mode computes it identically.

Lifecycle:

- Each `open()` call registers its key on entry and releases it in its `finally`,
  reference-counted. The registry entry lives exactly as long as at least one
  concurrent open of that attachment+mode is in flight.
- The first deadline to fire for a key logs the timeout and marks the entry
  `emitted`; later deadlines for the same live entry emit the user copy only.
- When the last concurrent caller releases the key, the entry is dropped, so a
  genuinely later, separate open of the same attachment logs its own timeout.

This is correct under every retry/join topology because it depends on neither
flight identity nor deadline ordering:

- **At most one** log per concurrent batch — all share one `emitted` flag.
- **At least one** — whichever caller times out first logs, owner or joiner.

## Consequences

- The per-flight `timeoutLogged` cell, the `activeFlight`/`ownsActiveFlight`
  tracking, and the entire `useFlight` parameter threaded through
  `openWithinDeadline` / `fetchAndMaterialize` / `retryStaleAttachment` are
  removed; flights no longer carry any timeout-log state.
- A pre-flight timeout with no key registered cannot happen — the key is
  registered before the deadline arms.
- Tests assert exactly one `timeout` warning across both stale-retry topologies
  (F1 splits to F2; F1's chain joins an already-in-flight F2) and that a fresh
  later open can still log.
