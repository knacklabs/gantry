---
name: ponytail-cutover-preauthorized
description: User pre-authorized the ponytail Phase-8 offline cutover (2026-07-20 night) — execute when the ship gate is fully green; abort on any red
metadata: 
  node_type: memory
  type: project
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
---

2026-07-20 ~evening: user said "Do it, you have the authority" in direct
response to "what I need for ponytail = the Phase-8 cutover go". The offline
cutover (stop runtime → pg_dump backup → baseline restamp per the RUNBOOK in
docs/architecture/ponytail-execution-ledger.md → canonical revision → build →
gantry restart) is PRE-AUTHORIZED without a further ask.

**Why:** user is asleep; wants the ship completed overnight.

**How to apply (STRENGTHENED, user 2026-07-20 late):** implement ponytail
Phases 5-7 and commit on the branch, but the MERGE + Phase-8 cutover wait
until the E2E suite is FULLY IMPLEMENTED and PASSING AGAINST THE PONYTAIL
BRANCH — i.e. the required-gate e2e rows of
docs/architecture/agent-e2e-test-matrix.md (packaged-runtime scenarios: boot/
restart, haiku turn, skill lifecycle, MCP, permission, capability, memory,
jobs, attachments/webhook, incident regressions, all-tools sweep; label-gated
live rows excluded) are built and green with the ponytail changes merged into
the candidate. Then the full ship gate (typecheck, full unit, test:e2e,
test:e2e:postgres, test:integration:postgres + chaos, hermetic + turn agent
lanes) + post-restart `scripts/agent-job-smoke.sh` PASS. ANY red → stop, no
cutover, wake-up report. Rollback = pre-cutover backup + rollback stamps.
Phase 9 deferred to its window. Related: [[e2e-required-for-merges]].
