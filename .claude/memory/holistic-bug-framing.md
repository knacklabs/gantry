---
name: holistic-bug-framing
description: "When the user reports a bug, always reframe holistically — bug vs feature-gap vs refactor/simplification — never fix narrow"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
---

When the user reports a bug, do NOT scope to the narrow symptom fix. Always
reframe in three layers before proposing work: (1) the immediate bug, (2) the
design inconsistency or feature gap that made the bug possible, (3) the
refactor/simplification that retires the whole class.

**Why:** the user thinks in product/architecture terms, not tickets. A narrow
patch leaves the sibling instances and the root design smell in place — which
is the recurring bug-pattern-family concern ([[bug-pattern-simplification-habit]]).

**How to apply:** for every bug report, before/alongside the fix, state: is this
just the bug, or does it signal a feature that needs implementing, or scattered
logic that needs unifying/deleting? Ship the fast fix for live annoyances, but
always surface the holistic refactor and fold it into the relevant lane. Example
(2026-07-20): "allow-for-future posts a receipt" was really "3 scattered
permission-acknowledgement sites with no shared ambient-only policy" →
[[no-status-clutter-in-chat]]. Pairs with the ponytail deletion-over-addition
instinct.
