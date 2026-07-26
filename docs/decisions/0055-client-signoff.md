---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-25
---

# Client Signoff

## Context
PERM-4 (PR #292) removed the 5-minute timebox on interactive permission prompts and
user questions. That created a new requirement: previously a stale prompt
self-resolved when its timeout fired, but with no timeout an aborted or crashed
turn would leave its prompt actionable forever, and a late approval could still
persist a permission rule for a call that no longer exists. PERM-4 therefore
introduced a durable cancellation lane, which became the single largest source of
late review findings — roughly ten across eight closeout cycles (claimed-request
no-ops, non-terminal consumption, handler exceptions, restart replay reservation,
batch fan-out erasure, auth-vs-retention lifetime mismatch). Each was real and
fixed, but they arrived one layer at a time because this is a distributed-systems
problem, not a defect list. Issue #293 was filed to address the class deliberately.

## Decision
Ravi selected issue #293 on 2026-07-25 to proceed as CANCEL-1 on branch
`feat/CANCEL-1-durable-cancellation-hardening`: write the cancellation invariant and
claim/ack lifecycle down as a decision record, audit every propagation path against
it (direct permission, coalesced batch members, user questions, all four channels,
runner side), test the races directly, bind the retention/auth lifetimes in one
place, and consolidate the two near-identical cancellation directories where that
is provably safe. This sets `client_signoff: true` and authorizes planning →
decomposition → implementation.

## Consequences
- Phases at `planning` or later are unblocked for CANCEL-1.
- Scope is hardening and consolidation of an existing, shipped lane — not new
  user-facing behavior. The PERM-4 invariants stay as shipped: rails authoritative
  on every path, auto-allow only when the effect is inspectable, and authentication
  freshness never used as an interaction deadline.
- Accepts that a lost cancellation is the failure mode with security impact (a
  cancelled turn's prompt could still approve or persist a rule), so exhausted
  retention must be observable rather than silent.
- See [[perm-4-legibility-birthright]] context in
  [[permission-holistic-redesign]]; supersedes nothing.
