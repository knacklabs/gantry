---
name: preexisting-live-admission-failures-main
description: 3 live-admission integration tests fail on clean origin/main (post PR
metadata: 
  node_type: memory
  type: project
  originSessionId: 84c1b7c7-db24-491d-bfe0-70b0db54c380
---

As of 2026-07-07 (origin/main = 6612bb371, after PR #194 merge), these integration
tests fail on a CLEAN checkout with no local changes:

- `live-admission-work-items.postgres.integration.test.ts` — 2 tests: expected
  `messageId`/`queueJid` WITHOUT provider-account prefixes, but repository now
  emits `message:channel-providerAccount:default:telegram:...` /
  `...::agent:...::provider_account:...` (test expectations never updated when
  provider-account keying landed in 0091/0092).
- `live-waiting-admission.postgres.integration.test.ts` — 1 test: renderMetrics
  output missing `gantry_live_slots_used_cluster`.

Verified by `git stash -u` + rerun during company-brain-core work. Do not treat
as regressions in feature branches; see also [[preexisting-test-failures-credential-branch]]
and [[preexisting-markrunnotified-mock-failure]].
