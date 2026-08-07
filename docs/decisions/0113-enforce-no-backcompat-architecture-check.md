---
status: proposed
confirmed_by: ""
date: 2026-08-07
stories: [LEGACY-1]
---

# Enforce 0003 in check:architecture via Exception Records [LEGACY-1]

## Context

`0003-early-stage-no-backcompat` is policy, but nothing enforces it — which is
how the audited compat readers (silent migration, dual-read, ownership
reconstruction, remote→local fail-open) got added after it. Removing them once
without a guard invites them back.

## Decision

Extend `check:architecture` with a rule: a new runtime **compat branch** — silent
stale-state migration, dual-read, ownership reconstruction, or a fallback from an
authoritative remote to a local copy — fails the check unless it carries a
time-boxed exception record:

```
symbol: migrateLegacyAgentBindings
owner: settings
reason: temporary rolling-upgrade bridge
introduced: 2026-08-03
removal_condition: all active settings revisions are schema version N
remove_by: 2026-08-15
kind: dual_read
```

Explicitly **allowed without an exception** (not internal-state compat):
reject-only validation of a stale field; external protocol / vendor
compatibility (OTel keys, SDK entry points); a time-boxed rolling-deployment
bridge (which still needs a record); historical migration files. The rule
operates on a small exact exception list plus known symbols/files — never a raw
keyword ban on "legacy"/"compat" (false positives).

## Consequences

- New compat requires an explicit, owned, time-boxed record; the check fails
  otherwise, so drift is visible in review instead of silent.
- The check runs where `check:architecture` already runs (verify.py locally);
  note that gate is not yet in CI (existing gap), so base-commit hygiene still
  applies. Enforces `0003`; pairs with `0112`.
