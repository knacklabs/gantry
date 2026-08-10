---
slug: audit-2
title: Security and architecture audit paydown
status: draft
saved: 2026-08-10T19:42:07+00:00
---

# AUDIT-2 — Security and architecture audit paydown

## Why

An external security/architecture audit (2026-08, against snapshot `bb340b0ae`) found 5 High,
6 Medium, and 1 Low issue, plus five simplifications. The theme is that individually sound
controls do not form one end-to-end ownership boundary — fleet and persistence capabilities
shipped ahead of their ownership models. The findings are stale by 28 commits and several may
already be fixed (the Low arch-gate finding already is), so they must be verified against
current main before any code is written, then the confirmed blockers fixed or split into
planned stories.

## Behaviour

- A read-only verification pass (Codex, via `forge delegate --read-only`) checks each audited
  item against current main and returns a per-item verdict — confirmed-current, changed, or
  already-fixed — with current file:line evidence.
- Confirmed blockers (browser upload ownership, webhook secret encryption + create contract,
  browser profile resource budgets, integrity fail-open, durable snapshot publication, cluster
  rate authority) are either fixed here when small and self-contained, or split into their own
  planned stories when they need an architecture decision.
- The no-op credential-binding machinery simplification is deleted if verification confirms the
  production functions are still no-ops.
- Rejected and already-fixed items are recorded as closed with the reason, so they are not
  re-audited.

## Acceptance criteria

- Every audited High, Medium, and simplification carries a current verdict with file:line.
- Confirmed blockers are fixed or captured as their own planned stories; nothing confirmed is
  left untracked.
- Rejected/already-fixed items are recorded closed with rationale.

## Source

docs/architecture/audits/audit-2026-08-bb340b0ae.md (full audit text).
