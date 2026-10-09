# Delegated follow-up test readiness

## Scope and acceptance

Only the existing delegated-answer Postgres integration test and this note change:
one code file, no interface-glob matches, no production changes or new seams.
The parent wake-up case must wait at most 10 seconds for the real admission
claim to return its exact task, then preserve the agent/conversation/thread,
full-answer message, and delivered receipt assertions. The separate full-stream
answer case remains intact. This fix leaves production batching unchanged.
After reconciling current main, the case also preserves upstream's immediate
helper-follow-up admission: `claimNow` is captured before delegation and passed
unchanged to every claim. Polling cannot make a deferred quiet-window row due.

## Test audit

- Contract: signed delegation through the real child process, IPC, completion
  persistence, and Postgres admission produces the complete answer on the parent
  route and records delivery.
- Historical diagnosis: the original immediate claim preceded the then-normal
  1500ms quiet window. Main now admits helper notices immediately; this is no
  longer a reason to wait for elapsed admission time.
- Current regression: notification persistence may follow task completion, but
  a persisted helper notice must be claimable even at the pre-delegation clock.
- Owner: the existing `immediately wakes the chat parent with a durable delegated completion result` case in
  `apps/core/test/integration/delegated-answer-and-parent-wakeup.postgres.integration.test.ts`.
  Extend this owner rather than add duplicate coverage. The sibling streamed
  answer case protects accumulation independently.
- Seam: none. Only the external model provider is replaced by the existing
  fixture; storage, IPC and admission remain real. No junk-pattern matches:
  route, content and receipt expectations are independent observable outcomes.

The wait callback asserts only that its exact task was claimed and returns that
item immediately. Routing and content assertions stay outside polling, so a
wrong claimed item fails without attempting to claim it again. No fixed sleep,
fake clock, readiness override, skip, or weakened assertion is introduced.
No replacement or legacy cleanup applies; the premature single-claim assumption
is removed at its existing owner.

## Surface impact

| Surface                      | Classification       | Reason                                                               |
| ---------------------------- | -------------------- | -------------------------------------------------------------------- |
| Runtime behavior             | Unchanged by design  | Test-only readiness repair; batching is untouched.                   |
| `settings.yaml`              | Unchanged by design  | No configuration change required.                                    |
| Postgres/runtime projection  | Read-only/observable | Real disposable storage and claims exercise the existing contract.   |
| Control API                  | Unchanged by design  | No endpoint change required.                                         |
| SDK/contracts                | Unchanged by design  | No interface change required.                                        |
| CLI                          | Unchanged by design  | No command change required.                                          |
| Gantry MCP tools/admin skill | Unchanged by design  | No capability change required.                                       |
| Channel/provider adapters    | Unchanged by design  | Existing external-provider fixture remains sufficient.               |
| Docs/prompts                 | Changed              | This verification note; prompts untouched.                           |
| Audit/events                 | Unchanged by design  | No event or receipt contract change required.                        |
| Tests/verification           | Changed              | Bounded polling replaces immediate claim in the existing owner case. |

## Local verification

### Historical runs before reconciliation

These are local results, not a claim that CI is green. Publication belongs to
the coordinator; live runtime restart is outside this task.

Database setup (round two, fresh container with memory-backed data, no persistent
volumes):

```bash
docker run -d --name gantry-delegated-readiness-pg-r2 --tmpfs /var/lib/postgresql/data -e POSTGRES_USER=gantry_test -e POSTGRES_PASSWORD=gantry_test -e POSTGRES_DB=gantry_test -p 127.0.0.1:55439:5432 pgvector/pgvector:pg16
docker exec gantry-delegated-readiness-pg-r2 pg_isready -U gantry_test
docker exec gantry-delegated-readiness-pg-r2 psql -U gantry_test -d gantry_test -c 'CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;'
export GANTRY_TEST_DATABASE_URL=postgres://gantry_test:gantry_test@127.0.0.1:55439/gantry_test
```

| Command                                                                                                                                                                                                               | Result                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run test:integration:postgres -- apps/core/test/integration/delegated-answer-and-parent-wakeup.postgres.integration.test.ts` (original, round one)                                                               | Expected failure: parent follow-up undefined at line 272; 1 passed, 1 failed.                                                                                                        |
| Same focused command after repair (round one, three runs)                                                                                                                                                             | Each run: 1 file, 2 tests passed.                                                                                                                                                    |
| `npm run test:integration:postgres -- apps/core/test/integration/delegated-answer-and-parent-wakeup.postgres.integration.test.ts apps/core/test/integration/live-admission-quiet-window.postgres.integration.test.ts` | 2 files, 17 tests passed (12.31s).                                                                                                                                                   |
| `npm run test:integration:postgres`                                                                                                                                                                                   | 74 files passed; 459 tests passed, 1 existing skip (299.14s).                                                                                                                        |
| `npm run test:integration:postgres:chaos`                                                                                                                                                                             | 1 file, 1 test passed (4.28s).                                                                                                                                                       |
| `env -u GANTRY_TEST_DATABASE_URL npm test`                                                                                                                                                                            | Unit: 731 files, 9,224 tests passed (145.06s). Integration: 16 files passed, 83 skipped; 91 tests passed, 537 skipped (49.13s). Database-guarded skips are covered separately above. |
| `npx --yes -p node@24 -- sh -c 'npm ci && (npm run format:check && npm run check:architecture && npm run lint:changed) && npm run typecheck'` (exact Forge gate)                                                      | Passed, exit 0.                                                                                                                                                                      |

The full Postgres skip is the existing absent-database sentinel in
`mcp-server.postgres.integration.test.ts`, intentionally skipped when a database
is present. No skips were added. No additional runner asset build was needed.
Round one's initial invocation could not find `tsc` before dependency setup;
the exact Forge gate installed dependencies and passed. Its interrupted full
Postgres attempt has no result and is superseded by round two's completed run.

Cleanup: both required extensions were present and no test schemas remained.
`docker inspect` confirmed tmpfs data and localhost-only port binding;
`docker rm -f -v gantry-delegated-readiness-pg-r2` removed the container.
`docker ps -a --filter name=gantry-delegated-readiness-pg` then returned no rows;
round one's container had already been removed by the coordinator.
Generated logs live under ignored `node_modules/.cache/delegated-readiness/`,
including the preserved round-one logs. No generated logs are committed.
Logs were held in memory and restored after the gate's `npm ci` cleared
`node_modules`. Final whitespace and scoped formatting checks passed.

### Current reconciliation

Merged `origin/main`, including its security dependency upgrades and APT refresh,
and regenerated Forge-owned files with pinned Forge 1.2.7. Only the delegated
test conflicted. Its immediate-readiness name, pre-delegation `claimNow`, routing,
full-answer and receipt assertions remain intact; every poll uses that same
clock. No production edits were made beyond accepting upstream unchanged.
The eleven-surface matrix describes this fix's own changes relative to main.
Current proof (round three):

- `forge test` with pinned Forge 1.2.7 passed, exit 0. It ran current
  `forge.toml`'s `fast_test`: dependency installation, formatting, architecture,
  changed-file lint and typecheck. It did not run the full `test` command.
- Fresh disposable `pgvector/pgvector:pg16` was started with the round-two
  command using container name `gantry-delegated-readiness-pg-r3`; localhost
  binding, tmpfs data and both extensions were verified.
- With the same disposable URL, ran
  `npm run test:integration:postgres -- apps/core/test/integration/delegated-answer-and-parent-wakeup.postgres.integration.test.ts apps/core/test/integration/live-admission-quiet-window.postgres.integration.test.ts apps/core/test/integration/live-admission-work-items.postgres.integration.test.ts`:
  3 files, 54 tests passed, no skips (17.06s).
- The fixed-clock immediate parent wake-up and full-stream answer cases passed.
  Routing, message content and receipt assertions remain outside the poll.
- No schemas remained; `docker rm -f -v gantry-delegated-readiness-pg-r3`
  removed the container, and the name-filtered container listing was empty.
- Logs: `round3-forge-test.log` and `round3-focused-postgres.log` under the
  existing ignored cache directory. Final diff and formatting checks passed.

The earlier full-suite and chaos totals above are historical, not results on
this reconciled tree. No local image scan was run: the image-security changes
are accepted from main unchanged, and the coordinator will update the existing
pull request for CI. No security ignores, new tests or skips were added.
