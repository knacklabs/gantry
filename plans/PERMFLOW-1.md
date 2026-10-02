# One permission gate on the host that asks only when needed

6 parts · Risks: more calls reach the safety judge instead of a person · New moving parts: none

## What changes for you

- The agent asks you less. A command is no longer put to you just because of how it's written, with pipes, `&&` chains or heredocs. Only real danger stops it outright; everything else goes to the safety judge, and when the judge says it's fine you aren't asked.
- Chat and scheduled jobs get the same answer for the same action, on every agent engine.
- Every permission prompt reads the same way. It says in plain words what the agent wants to do, which account, file or command is involved (secrets hidden), and why. It has three buttons: Allow once, Allow for future, Deny. Admin actions such as installing a skill or restarting show only Allow once and Deny.
- One question is one message. Answering it updates that message; there are no extra "approved", "resumed" or "safety judge offline" messages.

## Why

See the spec: [Scheduled jobs and chat share one permission flow](../docs/specs/one-permission-flow.md).

In the last 30 days people were asked 110 times, and the safety judge was overruled 69 times. In those 69 it had said "allow", but a stricter check turned that back into a question because of how the command was written. Each agent engine also keeps its own copy of the permission checks, and the copies disagree. The DeepAgents engine runs Gantry's own tools with no check at all. The inline lane cancels a scheduled run where the main path would ask.

## Done when

1. **For the same action, a chat turn and a scheduled job get the same permission decision, on every agent engine, and no tool call skips the check.**
2. **A command is never put to a person just because of how it's written. Only real danger stops it outright; otherwise the safety judge decides, and when it allows, nobody is asked.**
3. **Every permission prompt says what the agent wants to do, the specifics with secrets hidden, and why, with Allow once / Allow for future / Deny, or Allow once / Deny for admin actions.**
4. **One question produces one message, and answering it updates that message with nothing extra sent.**

## Risks

- **More calls reach the safety judge instead of a person.** Commands that only looked unusual (pipes, chains, heredocs) now go to the judge. The hard rules still stop destructive actions, secret or credential paths, privilege changes, uploads, download-then-run and inline interpreter code such as `python -c …`, and the judge can only allow or ask.

No one-way steps: no data is deleted and nothing is migrated.

## For the builders

### Done-when details

1. **Same decision on every engine.**
   - **Agent modes.** Owner choice, 2026-10-02: the modes stay as settings an owner picks.
     - `auto`, the default, gets this behaviour: the judge decides, and people are asked only when needed.
     - `ask` deliberately asks a person for anything a hard rule or saved approval doesn't settle.
     - `auto_strict` asks unless a call is proven read-only or the judge allows it.
     - Scheduled jobs follow their agent's mode, like chat.
     - In `auto` and `auto_strict`, shapes (pipes, chains, heredocs) reach the judge.
   - **The ladder order.** It is fixed in the host gate (`coordinatePermissionDecision`, `apps/core/src/runtime/permission-decision-coordinator.ts`): route check (the conversation's route and binding must exist, or the call is refused), then hard rules and the admin always-ask bucket, then saved approvals, then the verdict cache, then the classifier, then the ask. A saved or reviewed-rule allow, or a cached or classifier allow, never overrides a hard rule or an admin ask; today a reviewed-rule allow returns before the rails.
   - **One tail.** One host tail (route guard, classifier, then prompt or job attach) is used by:
     - the IPC path;
     - the inline remote-MCP path;
     - the core-tool coordinator.

     The inline scheduled-run cancel (`app/bootstrap/inline-agent-loop-tools.ts` ~426-445) is gone.
   - **What enters the gate.** Every tool call does, from the Claude Agent SDK runner, the DeepAgents runner (including every Gantry MCP tool in `runner/mcp-tools.ts`), and both inline lanes (including core tools, which the Claude inline lane allows blindly today).
   - **Dispatcher tools.** `mcp_call_tool` and `capability_run` are judged on their resolved server and tool, or capability.
   - **One invocation id.** The gate carries an engine-supplied invocation id (the SDK tool-use id, or the LangChain tool-call id), pinned by T1. It is scoped to the authenticated run, app and agent, and bound to a hash of the action. The same id with different arguments is rejected, and an id from another run never matches. A missing or malformed id gets a fresh host id, so it gets its own ask. T2 sends it on every request, and T5 keys the one waiting record on it. A second legitimate call of the same tool has a different id and gets its own ask; the same call seen under two names (for example with an `mcp__gantry__` prefix) has the same id and gets one ask.
   - **Runner checks.** Runners keep only checks the host can't make: the sandbox network gate, the wait-only Bash guard and the memory-boundary check (its suppressed-memory marker lives only in the run). Protected-path and yolo checks run once, on the host. The job heartbeat (`runner/job-heartbeat.ts`) reads pending requests from the shared client, so a job waiting for permission still reports it. There is one runner IPC client (`apps/core/src/runner/permission-ipc-client.ts`); the Claude runner's duplicate (`runner/permission-callback.ts`) is deleted.
   - **Proof.**
     - Gate tests with a matching saved approval plus a cached or classifier allow, showing a hard rule and every admin action still ask or stop.
     - A table test running one set of calls through the Claude runner, the DeepAgents runner and both inline lanes, as a chat turn and as a job.
     - Tests for one call seen under two names (one ask) and two real calls (two asks). Also: the same id in different runs, changed arguments under one id, and a missing or malformed id.
     - Route cases: a missing or removed conversation route refuses even when a saved approval or a cached allow matches.
     - A heartbeat test showing a waiting job still reports its pending request.
     - A named end-to-end test, `deepagents-gantry-tool-gate`.
2. **Only real danger stops a command.**
   - **What hard rules stop.** They decide alone only for:
     - destructive actions;
     - secret or credential paths;
     - privilege changes;
     - uploading local files;
     - download-then-run;
     - inline interpreter code, such as `python -c`, `node -e` or `bash -c` with a code string.

     A pipe, a chain, a heredoc or a command the parser can't model goes to the classifier. `apps/core/src/domain/permission-deterministic-rails.ts` stops returning asks for shape alone.
   - **A classifier allow is final.** The rail veto in `mergeIpcClassifierWithRail` (`runtime/ipc-permission-classifier-decision.ts`) is removed by T1, which owns that file.
   - **Truncated input.** Truncation happens in `runtime/ipc-parsing.ts`. Before anything is cut, the hard rules run on the complete action, and a summary naming every program and path is built from it. The classifier gets that summary, so truncation alone never causes an ask. Missing or malformed input still asks.
   - **The verdict cache.** It is keyed by exact action, agent, conversation and lane. Its key is pinned by T1, in `runtime/permission-judge-outage.ts`.
   - **`capability_run` and reviewed read capabilities.** They are judged like other calls and are not fixed as high risk.
   - **A command-template mismatch.** The call goes through the gate as the program it runs, with executable verification and the sandbox kept, so the classifier or a person decides. It is not refused on every run (`jobs/structured-local-cli-invocation.ts`). The mismatch is logged once per capability, and no amendment is applied automatically.
   - **Proof.**
     - A rail unit table with every shape reaching the classifier and every danger class still stopping.
     - Truncation cases: danger beyond the cut still stops, paths beyond the cut appear in the summary, and missing or malformed input asks.
     - Template-mismatch cases: repeated runs, restart, allow and deny.
     - A Postgres integration test of the real ladder for a piped and chained command.
     - A named end-to-end test, `piped-command-judge-allow`.
3. **One prompt shape.**
   - **Buttons.** Scalar prompts, auto-mode cards and admin prompts all show:
     - **Allow once:** the `allow_once` decision.
     - **Allow for future:** today's save target, either `allow_persistent_rule` or `remember_allow_exact`, whichever the request already offers. Program and capability targets arrive in PERMFLOW-2.
     - **Deny:** `cancel`. It is never remembered, so `remember_deny_exact` is no longer offered.

     Where nothing can be saved, and for admin actions, only Allow once and Deny show.
   - **Removed.** The card alternative ("Allow all `git` commands", "Just this once"). Batching is removed too: simultaneous asks are delivered as individual prompts and answered independently, and `permission-batch-coalescer.ts` and its "Allow all / Review each / Deny all" set are deleted.
   - **Wording.** The prompt shows the friendly capability name when there is one, the program names and the command (secrets hidden), and a "why" line from the turn's request. Internal reasons are never shown. The "Reply in 1440m" line is removed.
   - **After a restart.** The display fields (friendly name, programs, redacted command, why line) are persisted in the durable request snapshot (`application/interactions/pending-interaction-permission-envelope.ts` `durablePermissionRequestSnapshot`), so a recovered prompt shows the same details without exposing secrets.
   - **Proof.**
     - Rendering tests on Telegram, Slack, Discord and Teams for a shell command, a capability and an admin action.
     - Interaction tests that each button records the decision above, and that Deny saves nothing.
     - A test that simultaneous asks get separate prompts and independent answers.
     - A restart test that a recovered prompt keeps its details with secrets hidden.
     - A named end-to-end test, `permission-prompt-shape`.
4. **One question, one message.**
   - **Records.** One ask creates one waiting record and one prompt row, keyed by the invocation id from item 1; there is no bind-twice.
   - **Answering.** It updates the prompt message in place on every channel, live and after recovery. Discord, Teams and Telegram's recovered-prompt path (`channels/telegram/permission-callback.ts`) stop deleting approved prompts. When an edit fails, nothing extra is sent: the answer is logged and applied.
   - **Removed messages.** The separate approved, resumed and capability-amendment follow-up messages. The judge-offline chat notice is also removed, by T1, which owns that file; it becomes a log line and a prompt reason.
   - **Resend after a crash.** A prompt whose delivery is unknown after a crash is resent at most once, tracked durably on the prompt row. Either copy answers the ask, and a copy the runtime lost track of says the request was already answered.
   - **Proof.** A Postgres integration test counting records and messages per ask. Named fault cases:
     - a crash after send;
     - a second crash during the resend;
     - concurrent taps on both copies;
     - a lost message locator;
     - an already-settled ask;
     - approval after a restart where the edit fails, with no extra message.

     A named end-to-end test, `one-question-one-message`.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | One ladder and one tail on the host | The fixed ladder order (hard rules and admin asks first); one tail for IPC, inline remote MCP and core tools; the inline scheduled cancel removed; the classifier-allow veto removed; the invocation id and the verdict-cache key pinned; the judge-offline notice reduced to a log line and reason | 1, 2 | `apps/core/src/runtime/permission-decision-coordinator.ts`, `apps/core/src/runtime/ipc-permission-classifier-decision.ts`, `apps/core/src/app/bootstrap/inline-agent-loop-tools.ts`, `apps/core/src/runtime/core-tools/core-tool-permission-coordinator.ts`, `apps/core/src/runtime/permission-judge-outage.ts`, `apps/core/src/application/permissions/permission-judge-outage-latch.ts`, `apps/core/src/domain/types.ts` (invocation id field only) | Gate tests with saved approvals and cached or classifier allows versus hard rules and every admin action; the three callers reach one tail; a scheduled inline run asks instead of cancelling | | yes |
| T2 | One runner client and runner-only checks | One runner IPC client carrying the invocation id; the Claude runner's duplicate client deleted; runner pre-checks reduced to the sandbox network and wait-only Bash guards | 1 | `apps/core/src/adapters/llm/anthropic-claude-agent/runner/permission-callback.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/protected-capability-hook.ts`, `apps/core/src/runner/permission-ipc-client.ts`, `apps/core/src/runner/tool-gate-core.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/job-heartbeat.ts` | Runner unit tests that every request carries the invocation id and that protected-path and yolo checks no longer run in the runner; a heartbeat test that a waiting job still reports its pending request | T1 | no |
| T3 | Every engine call reaches the gate | DeepAgents Gantry MCP tools and inline core tools are gated; `mcp_call_tool` and `capability_run` judged on their resolved target | 1 | `apps/core/src/adapters/llm/deepagents-langchain/runner/**`, `apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/index.ts`, `apps/core/src/adapters/llm/deepagents-langchain/inline-lane/**`, `apps/core/src/runtime/core-tools/registry.ts` | The engine decision table test (Claude runner, DeepAgents runner, both inline lanes; chat and job; `auto`, `auto_strict` and `ask` modes); one call under two names versus two real calls; named end-to-end test `deepagents-gantry-tool-gate` | T2 | yes |
| T4 | Only real danger stops a command | Rails stop only real danger, including inline interpreter code; shapes go to the classifier; truncation summarised from the complete action; `capability_run` not fixed high; a template mismatch goes through the gate as its program | 2 | `apps/core/src/domain/permission-deterministic-rails.ts`, `apps/core/src/runtime/ipc-parsing.ts`, `apps/core/src/runtime/permission-classifier.ts`, `apps/core/src/runtime/permission-classifier-native-risk.ts`, `apps/core/src/application/permissions/gantry-tool-risk.ts`, `apps/core/src/jobs/structured-local-cli-invocation.ts`, `apps/core/src/jobs/ipc-capability-run-handler.ts` | Rail unit table per shape and danger class; truncation cases; template-mismatch cases; Postgres integration of the real ladder for a piped and chained command; named end-to-end test `piped-command-judge-allow` | T1 | yes |
| T5 | One prompt shape | Three buttons with pinned decisions (two for admin actions and nothing-to-save); Deny never remembered; batching removed; plain what, which and why wording; prompt details kept across restart | 3 | `apps/core/src/channels/permission-interaction.ts`, `apps/core/src/channels/permission-decision-options.ts`, `apps/core/src/channels/permission-card-affordances.ts`, `apps/core/src/application/permissions/permission-card-affordances.ts`, `apps/core/src/channels/permission-batch-coalescer.ts`, `apps/core/src/channels/permission-approval-requester.ts`, `apps/core/src/channels/permission-prompt-wait-line.ts`, `apps/core/src/channels/permission-tool-input-format.ts`, `apps/core/src/application/interactions/pending-interaction-permission-envelope.ts`, `apps/core/src/channels/telegram/prepared-permission-card.ts`, `apps/core/src/channels/slack/permission-approval-delivery.ts` | Rendering tests on four channels; button-to-decision interaction tests; simultaneous asks answered independently; prompt details survive restart; named end-to-end test `permission-prompt-shape` | | yes |
| T6 | One question, one message | One waiting record and one prompt row per invocation; answers update the prompt in place on every channel; no approved, resumed or amendment messages; crash resend at most once, tracked durably | 4 | `apps/core/src/application/interactions/pending-interaction-durability.ts`, `apps/core/src/application/interactions/pending-interaction-permission-recovery-orchestrator.ts`, `apps/core/src/adapters/storage/postgres/repositories/worker-coordination-permission-prompt.postgres.ts`, `apps/core/src/runtime/ipc-interaction-processing.ts`, `apps/core/src/jobs/ipc-capability-template-amendment.ts`, `apps/core/src/channels/telegram/permission-prompt-settlement.ts`, `apps/core/src/channels/discord/permission-prompt-settlement.ts`, `apps/core/src/channels/telegram/permission-callback.ts`, `apps/core/src/channels/slack/channel-interactions.ts`, `apps/core/src/channels/teams/interaction-handlers.ts` | Postgres integration counting records and messages per ask, with the five named fault cases; named end-to-end test `one-question-one-message` | T1, T5 | yes |

New moving parts: none

## Notes

- **Next stories in this spec:**
  - PERMFLOW-2: saved approvals by capability or program, per conversation, in one store, with the carry-over;
  - PERMFLOW-3: jobs as unattended turns on the chat prompt and run loop;
  - PERMFLOW-4: removal of the job card, setup pause and bounded records.

  "Allow for future" keeps today's save target until PERMFLOW-2.
- **Machine load.** Builders run only their own task's tests. Close runs the suites one at a time.
