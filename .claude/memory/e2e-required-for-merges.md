---
name: e2e-required-for-merges
description: Standing policy — no PR merges without E2E coverage once the agent-e2e gate exists; Stage C runs in parallel with other lanes
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
---

User directive (2026-07-20): the agent-E2E gate is the merge bar. Once the
`agent-e2e-gate` workflow lands, PRs do not merge without it green, and feature
PRs must carry e2e coverage for new behavior (rows in
`docs/architecture/agent-e2e-test-matrix.md`). Stage C (packaged harness +
haiku-turn scenarios) builds IN PARALLEL with other lanes — do not serialize it
behind ponytail.

**Why:** releases were repeatedly burned by untested composed behavior (route
incident, render sandbox, silent audit loss). The user wants discipline:
behavioral tests, ponytail-minimal, tracked in the matrix.

**How to apply:** every implementation lane closes with matrix rows flipped
(🔨→✅ with citations); merges wait for e2e green; test-quality loop = write →
independent review → strengthen (mutation-verify where possible). Related:
[[holistic-bug-framing]], [[autoreview-scanner-phantom-bug]].

**Merge policy (user, 2026-07-20):** auto-merge PRs on CI green WITHOUT asking,
EXCEPT (a) the ponytail branch — waits for the ship gate + explicit cutover go,
and (b) PR #237 — waits for the full refactor stages + alignment. Bugs get
pinned by tests: every bug found becomes a test (matrix row) before/with its
fix.
