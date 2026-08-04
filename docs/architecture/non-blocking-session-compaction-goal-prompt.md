# Goal Prompt: Non-Blocking Async Session Compaction

## Objective

Implement non-blocking `/compact` for Gantry live conversations.

The product rule is: compaction must never block the user from getting a reply. `/compact` should run as runtime-owned background session maintenance on the existing provider session when safe, while new user messages continue through Gantry canonical continuity.

Use ponytail. Keep the change surgical. No compatibility shims. Do not invent a second conversation model.

## Required Behavior

- `/compact` returns immediately with: `Compaction queued. You can keep messaging me; I'll use the compacted context when it's ready.`
- If a live response is already running, queue compaction to start after that response finishes. Do not inject `/compact` into the active runner.
- If compaction is running and the user sends another message, reply immediately.
- During compaction, the compacting provider session is maintenance-locked and must not be resumed by normal live turns.
- Overlapping user messages run as no-resume ephemeral turns using:
  - same `AgentSession`
  - same conversation/thread
  - Gantry recent messages
  - session digests
  - memory context
  - current user message
- Ephemeral provider sessions created during compaction must not replace the durable provider-session head.
- When compaction finishes, promote the compacted existing provider session only at the next turn boundary and only if safe.
- Any messages/replies produced during compaction must be injected as a Gantry delta on the next resumed compacted provider turn.
- Deduplicate to one queued/running compaction per agent session/thread.
- `/status` must show compaction state: `idle`, `queued`, `running`, `ready`, `degraded`, or `failed`.

## Continuation Model

Use the existing provider session for the compaction operation. Do not start a new durable provider thread for normal compaction.

When compaction begins, record the compaction base cursor: conversation id, thread id, agent session id, durable provider session id, last persisted message id, and last completed run id. The provider session enters `maintenance_compact` and is locked from normal resume.

If the user sends message B while compaction A is running:

- Persist B and its assistant reply through the normal Gantry transcript/run path.
- Run B as `no_resume_ephemeral`, with no durable provider-session-head write.
- Keep all channel UX normal; the user should not wait for A.
- Track B and later overlap turns as the delta after the compaction base cursor.

When A completes:

- Mark the compacted provider session `ready`, not immediately active inside an in-flight turn.
- On the next turn boundary, resume the compacted provider session and inject the Gantry delta produced after the compaction base cursor.
- Only then clear the maintenance lock and make the compacted provider session the durable latest head.
- If the delta is too large or stale for safe replay, mark compaction `degraded`, continue from Gantry continuity, and queue a follow-up compaction only after the thread is idle.

Provider sessions are optimization handles. Postgres transcript, runs, artifacts, session digests, and memory remain canonical conversation truth.

## Implementation Shape

- Add a runtime-owned `SessionCompactionService`.
- Reuse existing `agent_async_tasks` machinery internally; add a new internal task kind such as `session_compaction`.
- Do not expose compaction as an agent-facing async task.
- Add an explicit provider session mode:
  - `resume_latest`
  - `no_resume_ephemeral`
  - `maintenance_compact`
- Add repository support to:
  - mark a provider session maintenance-locked
  - query whether the latest provider session is locked
  - record the compaction base cursor
  - list transcript/run deltas after the compaction base cursor
  - persist ephemeral run metadata without replacing latest provider session
  - promote compacted provider session with compare-and-swap ownership checks
- Anthropic SDK path: background task resumes the existing provider session and sends `/compact`.
- DeepAgents path: same public UX, but backend refreshes Gantry continuity/checkpoint state instead of sending a literal provider slash command.
- Keep provider-specific compaction inside execution adapters. Core runtime owns admission, locking, task lifecycle, status, and receipts.

## User Receipts

Terminal receipt rules:

- Success: `Compaction ready. I'll use the compacted context and updated memory on your next message.`
- Degraded: `Compaction ready, but memory extraction did not finish. I'll use compacted context and existing memory.`
- Failure: `Compaction did not finish. I'll keep using current continuity and memory.`

No periodic progress messages.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | `/compact` becomes non-blocking background session maintenance. |
| `settings.yaml` | Unchanged by design | No new user config. |
| Postgres/runtime projection | Changed | Async task kind, compaction base cursor, and provider-session maintenance state are persisted. |
| Control API | Read-only/observable | Existing status surfaces may expose compaction state if already wired. |
| SDK/contracts | Changed internally | Adds provider-session mode; no public SDK contract change required. |
| CLI | Read-only/observable | `/status`/runtime status may show compaction state; no new command required. |
| Gantry MCP tools/admin skill | Unchanged by design | Compaction is runtime maintenance, not an agent tool. |
| Channel/provider adapters | Changed | Channels render new receipts; providers keep adapter-local compaction behavior. |
| Docs/prompts | Changed | Update continuity/session docs for non-blocking compaction semantics. |
| Audit/events | Changed | Publish runtime events for queued/running/ready/degraded/failed compaction. |
| Tests/verification | Changed | Add focused unit/integration coverage for non-blocking compaction. |

## Acceptance Criteria

- A test with unresolved compaction proves `/compact` advances cursor and replies immediately.
- A test proves `/compact` during active response queues maintenance instead of injecting `/compact` into the runner.
- A test proves messages during compaction answer without resuming the locked provider session.
- A test proves ephemeral no-resume provider sessions do not replace the durable latest provider session.
- A test proves compaction records a base cursor and replays post-cursor deltas before normal resume.
- A test proves compaction completion promotes only at next turn boundary.
- A test proves messages produced during compaction are injected as delta on the next compacted turn.
- A test proves stale or oversized deltas degrade safely instead of blocking the user.
- A test proves memory timeout yields degraded receipt and does not block replies.
- A test proves duplicate `/compact` requests return already queued/running status instead of creating duplicate work.
- Architecture check remains clean.

## Focused Verification

Run focused checks first:

```bash
npm run test:unit -- apps/core/test/unit/session/session-commands.test.ts apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/jobs/compact-memory.test.ts apps/core/test/unit/runner/agent-runner-ipc.test.ts
npm run test:unit -- apps/core/test/unit/runtime/session-resume-runtime.test.ts apps/core/test/unit/application/session-resume-use-cases.test.ts
npm run test:integration:postgres -- apps/core/test/integration/session-continuity.postgres.integration.test.ts apps/core/test/integration/domain-repositories.postgres.integration.test.ts
python3 .codex/scripts/check_architecture.py
```

Closeout pipeline:

```bash
npm run build
npm test
python3 .codex/scripts/check_task_completion.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/verify.py
```

Runtime smoke after implementation:

```bash
launchctl kickstart -k gui/$(id -u)/com.gantry
launchctl print gui/$(id -u)/com.gantry
gantry status
curl --unix-socket /Users/ravikiranvemula/gantry/run/control.sock http://localhost/healthz
curl --unix-socket /Users/ravikiranvemula/gantry/run/control.sock http://localhost/readyz
```

Run autoreview before closeout:

```bash
ps -ax -o pid,ppid,etime,command | rg 'autoreview|codex --ask-for-approval never --search exec|output-schema'
python3 /Users/ravikiranvemula/.codex/skills/autoreview/scripts/autoreview --mode local
```

## Subagent Prompt Template

Use subagents for implementation edits.

Each subagent prompt must include:

```text
Use ponytail.
No commentary.
Return changed files, checks run, and blockers only.

Implement the bounded slice below for Gantry non-blocking async session compaction.
Do not make product decisions. Do not add compatibility shims. Keep diffs surgical.
```

Suggested slices:

1. Session command and UX receipts.
2. Provider-session maintenance lock and repository behavior.
3. Background compaction service and async-task recovery.
4. Runner/session-resume integration for no-resume ephemeral turns.
5. Status/events/docs/tests cleanup.

## Assumptions

- Non-blocking user response wins over lowest provider-token cost.
- Normal compaction uses the existing provider session, not a new provider thread.
- Temporary no-resume turns are allowed only while the provider session is maintenance-locked.
- Provider sessions are optimization handles; Postgres transcript, runs, artifacts, digests, and memory remain canonical conversation truth.
- Compaction timeout default: 10 minutes unless existing runtime timeout policy provides a stricter safe bound.
