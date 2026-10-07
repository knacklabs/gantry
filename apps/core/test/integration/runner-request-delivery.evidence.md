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

## Evidence

- Before production edits, the early-close and timeout tests both failed with unhandled `write EPIPE` and host exit code 1. Abort and stop failed for the same reason; normal delivery passed.
- After the repair and helper extraction, all five dedicated real-process cases pass. The existing agent-spawn-process and agent-spawn suites pass (141 tests).
- `npm test` passes on Node 24.21.0 (9,224 unit tests and 96 integration tests); Postgres-backed suites skip with no test database URL. No database behavior changed.
- The initial architecture check found the existing owner exceeded its 700-line budget after adding the handler. `agent-spawn-process-input.ts` is the necessary additional production file: it owns stdin errors, synchronous delivery failures, and existing input metadata formatting. Its only production caller is executeRunnerProcess, which remains within budget. This is internal runtime factoring with no interface change.
- The exact Node 24 `forge.toml` gate passes: dependency install, format check, architecture, changed-file lint and typecheck. Lint has six non-blocking catch-all warnings (four existing owner warnings; two intentional new boundary catches). The initial dependency reinstall collided with Vitest's cache; the completed gate ran serially after tests.
- `npm run build` passes on Node 24, including core, contracts, SDK, web and examples. No replacement or legacy cleanup is involved; no old path or compatibility branch was added.
- Problems 3 and 4, live service restarts, Telegram/Slack checks, external models/auth and Postgres-specific verification are intentionally excluded.

## Final handoff

Early closure now returns static AgentOutput failure after stopping the runner. Timeout-induced pipe errors remain timeout results and write the existing timeout log. The two named acceptance cases in `runner-request-delivery.integration.test.ts` own this proof; abort/stop and intact normal delivery are distinct supporting contracts. No existing tests were edited or weakened. Four code files plus this note are the committed scope. The only production file added outside the original owner scope is `agent-spawn-process-input.ts`, required to keep that owner within its architecture budget. Production delta: +64 lines across the owner and helper. Test/support: two dedicated files, no production testing seams. PR creation, close and merge remain with the coordinator.
