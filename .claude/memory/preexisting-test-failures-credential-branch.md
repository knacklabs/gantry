---
name: preexisting-test-failures-credential-branch
description: "Two tests fail on the codex/credential-center-model-gateway branch independent of local changes — don't mistake them for regressions"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3f592261-ad8b-4e02-9c95-8852c74f698f
---

On branch `codex/credential-center-model-gateway` (base commit 9b1e31f0), two
tests fail independently of any working-tree changes — confirmed by stashing all
tracked changes and re-running:

- `apps/core/test/integration/jobs-runs-memory-flow.integration.test.ts` asserts
  `savedMemory.threadId === 'thread-scheduled'`, but `buildMemoryItemWriteBase`
  nulls `thread_id` (durable memory ignores thread id). Assertion mismatch, not
  a regression.
- `apps/core/test/e2e/runtime-setup-doctor.e2e.test.ts` (2 cases) expects doctor
  / `service status` exit 0, but they return 1 in a sandbox with no reachable
  default Postgres and no `SECRET_ENCRYPTION_KEY`. Environmental.

`verify.py` runs `npm test` **without** `GANTRY_TEST_DATABASE_URL`, so integration
suites skip there; it still runs the e2e phase, which fails on the doctor cases
above. To exercise integration tests, run a clean pgvector container
(`pgvector/pgvector:0.8.2-pg16`) on a spare port with a known password and set
`GANTRY_TEST_DATABASE_URL` — the persistent `gantry-postgres` volume may have an
unknown password. See [[ipc-mcp-stdio-fixture-copy-list]] for another test-fixture gotcha.

Update 2026-06-12: on `feature/deepagents-agent-engine`,
`jobs-runs-memory-flow.integration.test.ts` is GREEN (7/7) against a disposable
pgvector container — the red was specific to the credential branch. The doctor
e2e cases remain environmental. See [[deepagents-agent-engine-branch]].
