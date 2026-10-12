# Runner request delivery fix

Owner: fix/runner-input-pipe-crash (baseline ca1a63abc).

## Acceptance and scope

- Early stdin closure with a queued 2 MiB request returns a bounded static delivery error and stops the runner without crashing its host.
- Timeout killing a non-reading runner with pending input remains a timeout, writes timeout diagnostics, and leaves the host alive.
- Abort and requested stop retain their classification; successful input arrives intact.
- Change only executeRunnerProcess, a small input-lifecycle helper, one dedicated real-process integration suite and its isolated host fixture (four code files). No testing exports or flags in production.
- Problems 3 and 4 from the external findings, provider adapters, public interfaces and schemas are outside scope.

## Surface Impact Matrix

| Surface                      | Classification       | Reason                                                                                              |
| ---------------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed              | Own stdin errors before writes and stop failed request delivery.                                    |
| settings.yaml                | Unchanged by design  | Existing timeout and sandbox settings suffice.                                                      |
| Postgres/runtime projection  | Unchanged by design  | No storage contract involved.                                                                       |
| Control API                  | Unchanged by design  | Existing AgentOutput return path.                                                                   |
| SDK/contracts                | Unchanged by design  | No output shape changes.                                                                            |
| CLI                          | Unchanged by design  | No command changes.                                                                                 |
| Gantry MCP tools/admin skill | Unchanged by design  | No capability changes.                                                                              |
| Channel/provider adapters    | Unchanged by design  | Shared host owns stdin.                                                                             |
| Docs/prompts                 | Unchanged by design  | Only this task evidence note changes.                                                               |
| Audit/events/logs            | Read-only/observable | Existing startup/timeout diagnostics; static delivery-failure log without request or raw exception. |
| Tests/verification           | Changed              | Dedicated process-boundary regressions in the integration lane.                                     |

## Test audit before authoring

The primary cases protect host survival, early delivery failure and timeout classification at the real process boundary. Removing stdin error ownership reproduces unhandled EPIPE, which mocked PassThrough runner tests cannot reproduce. The isolated subprocess calls the existing executeRunnerProcess export with the real direct sandbox provider; only the external runner is a local Node fixture. No production seams are needed. Supporting cases protect abort/stop precedence and intact normal delivery through the same boundary. Output pipes are drained, watchdogs bounded, children killed and reaped, and temporary logs removed.

## Historical repair evidence — 7 October 2026

- Before production edits, the early-close and timeout tests both failed with unhandled `write EPIPE` and host exit code 1. Abort and stop failed for the same reason; normal delivery passed.
- After the repair and helper extraction, all five dedicated real-process cases pass. The existing agent-spawn-process and agent-spawn suites pass (141 tests).
- `npm test` passes on Node 24.21.0 (9,224 unit tests and 96 integration tests); Postgres-backed suites skip with no test database URL. No database behavior changed.
- The initial architecture check found the existing owner exceeded its 700-line budget after adding the handler. `agent-spawn-process-input.ts` is the necessary additional production file: it owns stdin errors, synchronous delivery failures, and existing input metadata formatting. Its only production caller is executeRunnerProcess, which remains within budget. This is internal runtime factoring with no interface change.
- The exact Node 24 `forge.toml` gate passes: dependency install, format check, architecture, changed-file lint and typecheck. Lint has six non-blocking catch-all warnings (four existing owner warnings; two intentional new boundary catches). The initial dependency reinstall collided with Vitest's cache; the completed gate ran serially after tests.
- `npm run build` passes on Node 24, including core, contracts, SDK, web and examples. No replacement or legacy cleanup is involved; no old path or compatibility branch was added.
- Problems 3 and 4, live service restarts, Telegram/Slack checks, external models/auth and Postgres-specific verification are intentionally excluded.

## Original repair handoff

Early closure now returns static AgentOutput failure after stopping the runner. Timeout-induced pipe errors remain timeout results and write the existing timeout log. The two named acceptance cases in `runner-request-delivery.integration.test.ts` own this proof; abort/stop and intact normal delivery are distinct supporting contracts. No existing tests were edited or weakened. Four code files plus this note are the committed scope. The only production file added outside the original owner scope is `agent-spawn-process-input.ts`, required to keep that owner within its architecture budget. Production delta: +64 lines across the owner and helper. Test/support: two dedicated files, no production testing seams. PR creation, close and merge remain with the coordinator.

## Reconciliation evidence — 9 October 2026

Scope for this round: merge current origin/main and verify the existing fix, then update this note. The original matrix describes our cumulative branch changes. This round adds no own source, test, settings, schema, API, SDK, CLI, MCP, channel or prompt changes. Docs/verification change only through this note and the checks below; logs remain observable static delivery failure and timeout evidence. No tests were added, weakened or duplicated and no production testing seam was introduced.

### Inherited fixes and PR state

- Merged origin/main at e5aafb2fe normally into this clean fix branch; merge commit cb5a291a0. There were no conflicts. The two EPIPE source files and two test/support files are byte-for-byte unchanged from the reviewed repair at 62cf7070f.
- Fresh PR #599 checks/comments: no conversation comments, inline review comments or reviews; the remaining failures are the historical CI run 37583685518 (undefined delegated parent follow-up) and image run 37583685551. No new remote checks were triggered in this round.
- Main includes merged PR #602: trusted callable-agent follow-ups bypass the human-message quiet window, and its existing parent-wakeup test uses a fixed claim clock. It also refreshes the Debian APT layer and security dependencies. These are inherited changes, not extra edits in our diff.
- `npm ls @modelcontextprotocol/sdk proxy-addr seroval shell-quote` confirms MCP SDK 1.32.1, proxy-addr 2.0.8, seroval 1.6.8 and shell-quote 1.12.0. `ops/docker/Dockerfile` inherits `APT_SECURITY_REFRESH=2026-10-08`.
- PR #602's [CI check](https://github.com/knacklabs/gantry/actions/runs/37769422566/job/113285468641) and [Image check](https://github.com/knacklabs/gantry/actions/runs/37769422499/job/113285431174) passed. That is upstream CI image evidence, not a new local Trivy scan or a green check on the reconciled PR #599 head. No scan suppression was added. The coordinator must push and obtain fresh checks through Forge close.
- PR #603 was neither cherry-picked nor edited. Forge settings and generated instructions were only inherited from main; the installed and configured Forge version is v1.2.7.

### Current verification

All checks ran serially under Node 24.21.0, with no source/test edits while suites ran. Per the coordinator's explicit instruction, the named focused suites and the full pinned test command ran directly; bare `forge test` also ran after the reconciliation merge was committed. Ignored logs under `.runner-input-round2.log/` survived both subsequent `npm ci` runs.

- `npm ci`: passed before focused verification.
- `npm run test:integration -- apps/core/test/integration/runner-request-delivery.integration.test.ts`: 5 passed. The early-close case returns the static safe error, kills the runner and excludes request/credential sentinels; timeout returns timeout and writes timeout diagnostics; abort/stop keep their classifications; normal delivery preserves the full request.
- `npm run test:unit -- apps/core/test/unit/runtime/agent-spawn-process.test.ts apps/core/test/unit/runtime/agent-spawn.test.ts`: 2 files, 141 passed.
- Created only our disposable container with `docker run --name gantry-runner-input-round2-20261009 --cidfile .runner-input-round2.log/postgres.cid -e POSTGRES_PASSWORD=test -e POSTGRES_DB=gantry_test -p 127.0.0.1::5432 -d pgvector/pgvector:pg16`. No host data volume was mounted. Readiness was confirmed with a real TCP SQL command; `vector` 0.8.7 and `pg_trgm` 1.6 were enabled before harness migrations.
- With its ephemeral URL in `GANTRY_TEST_DATABASE_URL`, `npm run test:integration:postgres --` selected `delegated-answer-and-parent-wakeup.postgres.integration.test.ts`, `live-admission-quiet-window.postgres.integration.test.ts`, `live-admission-work-items.postgres.integration.test.ts` and `live-admission-consumption-backfill.postgres.integration.test.ts`: 4 files, 55 passed, including `immediately wakes the chat parent with a durable delegated completion result` and the full streamed child answer. The initial command also supplied an unmatched `async-task-admission.postgres.integration.test.ts` selector; its actual owner was verified separately below.
- `GANTRY_TEST_DATABASE_URL=<owned disposable URL> npm run test:integration:postgres -- apps/core/test/integration/async-task-admission-contract.postgres.integration.test.ts`: 1 file, 1 passed. Total real Postgres proof: 56 passed across 5 suites.
- `docker stop <owned container id>` followed by `docker rm <owned container id>`: completed. A filtered `docker ps -a` confirmed the owned container was absent. No other containers or live runtime were touched.
- `npm run build`: passed for core, contracts, SDK, web and examples.
- Exact full pinned `forge.toml` test command: passed, exit 0: `npx --yes -p node@24 -- sh -c 'npm ci && (npm run format:check && npm run check:architecture && npm run lint:changed) && npm run typecheck && npm test'`. Its `npm test` ran 734 unit files / 9,265 passing tests and 17 integration files / 96 passing tests. The default integration lane skipped 84 files / 555 tests without a database URL; the relevant Postgres suites were separately proven above.
- Bare `forge test`: passed, exit 0, using the pinned `fast_test` (npm ci, formatting, architecture, changed-file lint and typecheck). Both gates had 0 lint errors and the same 6 non-blocking catch-all warnings documented in the historical run.
- `git diff --check origin/main`: passed. The own diff against main remains only the EPIPE source/test/evidence files and the fix's Forge record. No interface globs, unrelated source, dependency or image configuration changes were introduced by this round.

### Coordinator handoff

Both original Done-when items and abort/stop/normal delivery are proven after reconciliation. The current delegated helper immediate-wakeup test and its admission siblings pass on real disposable Postgres. The full pinned gate, bare Forge test and build pass. This round's only additional own edit is this evidence note; upstream fixes are inherited through the main merge. Historical failures remain documented separately from this new proof. The branch is committed locally; inspect it and run Forge close for the existing PR. No push, new PR, PR merge or live service restart was performed.
