# One permission gate on the host that asks only when needed

5 parts · Risks: more calls reach the safety judge instead of a person · New moving parts: none

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

- **More calls reach the safety judge instead of a person.** Commands that only looked unusual (pipes, chains, heredocs, short inline scripts) now go to the judge. The hard rules still stop destructive actions, secret or credential paths, privilege changes, uploads and download-then-run, and the judge can only allow or ask.

No one-way steps: no data is deleted and nothing is migrated.

## For the builders

### Done-when details

1. **Same decision on every engine.**
   - **What enters the gate.** Every tool call enters the host gate (`coordinatePermissionDecision`, `apps/core/src/runtime/permission-decision-coordinator.ts`), from:
     - the Claude Agent SDK runner;
     - the DeepAgents runner, including every Gantry MCP tool (`apps/core/src/adapters/llm/deepagents-langchain/runner/mcp-tools.ts`), which today run with no gate;
     - both inline lanes, including core tools, which the Claude inline lane allows blindly today (`apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/index.ts`).
   - **One tail.** There is one host tail (route guard, classifier, rail merge, then prompt or job attach). It is used by the IPC path, the inline remote-MCP path and the core-tool coordinator. The inline tail's scheduled-run cancel (`app/bootstrap/inline-agent-loop-tools.ts` ~426-445) is gone.
   - **Dispatchers.** `mcp_call_tool` and `capability_run` go through the gate for their resolved server and tool, or capability. The runner no longer allows them privately.
   - **Runner-only checks.** Runners keep only checks the host can't make: the sandbox network gate and the wait-only Bash guard. The protected-path, memory-boundary and yolo pre-checks run once, on the host. There is one runner IPC client (`apps/core/src/runner/permission-ipc-client.ts`); the Claude runner's duplicate (`permission-callback.ts`) is deleted.
   - **Proof.** A table test runs one set of calls through the Claude runner, the DeepAgents runner and both inline lanes, as a chat turn and as a job, and asserts the same decision each time. One named end-to-end test runs a DeepAgents Gantry tool through the real runtime and shows the gate deciding it.
2. **Only real danger stops a command.**
   - **What a hard rule stops.** It decides alone only for destructive actions, secret or credential paths, privilege changes, uploading local files, download-then-run and inline interpreter code.
   - **What goes to the classifier.** A pipe, a chain, a heredoc or a command the parser can't model goes on to the classifier. `apps/core/src/domain/permission-deterministic-rails.ts` stops returning hard-floor asks for shape alone.
   - **A classifier allow is final.** The rail veto merge (`apps/core/src/runtime/ipc-permission-classifier-decision.ts` ~434-523) no longer turns it back into an ask.
   - **Truncated input.** When the input had to be cut short, the judge gets a summary naming the programs and paths; truncation alone never asks (`apps/core/src/runtime/permission-classifier.ts` ~344-352).
   - **Verdict cache.** It stays keyed by the exact action, agent and conversation, and now also by lane.
   - **Capabilities.** `capability_run` and reviewed read capabilities are judged like other calls, not fixed as high risk (`apps/core/src/application/permissions/gantry-tool-risk.ts`, `apps/core/src/runtime/permission-classifier-native-risk.ts`). A command-template mismatch is reported once, not denied on every run.
   - **Admin actions.** They keep their "always ask" bucket.
   - **Proof.**
     - Unit tests over the rails show each shape (pipe, chain, heredoc, unparseable) reaching the classifier, and each danger class still stopping.
     - A Postgres integration test drives the real ladder: `cd x && ls | wc -l` reaches the classifier, and a classifier allow is not asked.
     - A named end-to-end test shows a piped command running after a judge allow with no prompt.
3. **One prompt shape.**
   - **Buttons.** Scalar prompts, auto-mode cards and admin prompts all render Allow once / Allow for future / Deny, or Allow once / Deny where nothing can be saved. The Deny label replaces Cancel and No. The card alternative ("Allow all `git` commands", "Just this once") and the batch "Allow all / Review each / Deny all" set are removed.
   - **Wording.** The prompt shows the friendly capability name when there is one, the program names and the command (secrets hidden), and a "why" line from the turn's request. Internal reasons are never shown. The "Reply in 1440m" line is removed.
   - **"Allow for future".** It keeps today's save target. Program and capability approvals arrive in PERMFLOW-2.
   - **Proof.** Rendering tests for Telegram, Slack, Discord and Teams on a shell command, a capability and an admin action. A named end-to-end test shows the prompt text and buttons for a real ask.
4. **One question, one message.**
   - **Records.** One ask creates one `pending_interactions` row and one `permission_prompts` row: no bind-twice, and no second record for an `mcp__gantry__`-prefixed copy of the same tool.
   - **Answering.** It updates the prompt message in place. The separate "approved"/"resumed" messages and the capability-amendment follow-up message are removed.
   - **Judge outage.** The "safety judge offline" notice is a log line and a prompt reason, not a chat message.
   - **Crash re-send.** A prompt whose delivery is unknown after a crash is sent at most once more. Either copy answers the ask; a copy the runtime lost track of says the request was already answered.
   - **Proof.** A Postgres integration test counts records and messages per ask, including a duplicated tool name and a crash-after-send fault.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | One host tail for every caller | One host tail function used by the IPC path, the inline remote-MCP path and the core-tool coordinator; the inline scheduled cancel removed; classifier eligibility and the verdict-cache lane key in one place | 1 | `apps/core/src/runtime/ipc-permission-classifier-decision.ts`, `apps/core/src/runtime/permission-decision-coordinator.ts`, `apps/core/src/app/bootstrap/inline-agent-loop-tools.ts`, `apps/core/src/runtime/core-tools/core-tool-permission-coordinator.ts`, `apps/core/src/application/permissions/judge-outage.ts` | Unit tests that the three callers reach the same tail; a test that a scheduled inline run asks where it used to cancel | | yes |
| T2 | Every engine call reaches the gate | DeepAgents Gantry MCP tools and inline core tools are gated; `mcp_call_tool` and `capability_run` judged on their resolved target; runner pre-checks reduced to runner-only checks; one runner IPC client | 1 | `apps/core/src/adapters/llm/deepagents-langchain/runner/**`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/permission-callback.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/runner/protected-capability-hook.ts`, `apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/index.ts`, `apps/core/src/runtime/core-tools/registry.ts`, `apps/core/src/runner/permission-ipc-client.ts`, `apps/core/src/runner/tool-gate-core.ts` | The engine decision table test (Claude runner, DeepAgents runner, both inline lanes; chat and job); named end-to-end test `deepagents-gantry-tool-gate` | T1 | yes |
| T3 | Only real danger stops a command | Rails stop only real danger; shapes go to the classifier; a classifier allow is final; truncation summarised; `capability_run` not fixed high; template mismatch reported once | 2 | `apps/core/src/domain/permission-deterministic-rails.ts`, `apps/core/src/runtime/permission-classifier.ts`, `apps/core/src/runtime/permission-classifier-native-risk.ts`, `apps/core/src/application/permissions/gantry-tool-risk.ts`, `apps/core/src/jobs/ipc-capability-run-handler.ts` | Rail unit table per shape and danger class; Postgres integration of the real ladder for a piped and chained command; named end-to-end test `piped-command-judge-allow` | T1 | yes |
| T4 | One prompt shape | Three buttons everywhere (two for admin actions and nothing-to-save); plain what/which/why wording; card alternative, batch buttons and the minutes countdown removed | 3 | `apps/core/src/channels/permission-interaction.ts`, `apps/core/src/channels/permission-decision-options.ts`, `apps/core/src/channels/permission-card-affordances.ts`, `apps/core/src/application/permissions/permission-card-affordances.ts`, `apps/core/src/channels/permission-batch-coalescer.ts`, `apps/core/src/channels/permission-approval-requester.ts`, `apps/core/src/channels/permission-prompt-wait-line.ts`, `apps/core/src/channels/permission-tool-input-format.ts`, `apps/core/src/channels/telegram/prepared-permission-card.ts`, `apps/core/src/channels/slack/permission-approval-delivery.ts` | Rendering tests on Telegram, Slack, Discord and Teams for a shell command, a capability and an admin action; named end-to-end test `permission-prompt-shape` | | yes |
| T5 | One question, one message | One pending record and one prompt row per ask; the answer updates the prompt in place; no approved, resumed, amendment or judge-offline messages; crash re-send at most once | 4 | `apps/core/src/application/interactions/pending-interaction-durability.ts`, `apps/core/src/adapters/storage/postgres/repositories/worker-coordination-permission-prompt.postgres.ts`, `apps/core/src/runtime/ipc-interaction-processing.ts`, `apps/core/src/runtime/permission-judge-outage.ts`, `apps/core/src/jobs/ipc-capability-template-amendment.ts`, `apps/core/src/channels/telegram/permission-prompt-settlement.ts`, `apps/core/src/channels/slack/channel-interactions.ts` | Postgres integration counting records and messages per ask, a duplicated tool name, and a crash-after-send fault | T1 | yes |

New moving parts: none

## Notes

- **Next stories in this spec:**
  - PERMFLOW-2: saved approvals by capability or program, per conversation, in one store, with the carry-over;
  - PERMFLOW-3: jobs as unattended turns on the chat prompt and run loop;
  - PERMFLOW-4: removal of the job card, setup pause and bounded records.

  "Allow for future" keeps today's save target until PERMFLOW-2.
- **Machine load.** Builders run only their own task's tests. Close runs the suites one at a time.
