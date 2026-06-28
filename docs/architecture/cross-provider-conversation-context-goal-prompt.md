# /goal Prompt: Cross-Provider Conversation Context

## Goal

Implement provider-neutral conversation context for live turns so Gantry can
answer when tagged in the middle of a channel, thread, reply chain, or topic
without replaying all history and without seeing only the triggering message.

Use `ponytail` full mode throughout: smallest correct change, no new settings,
no new memory system, no compatibility shims, no speculative abstractions.

## Execution Discipline

- Send no interim commentary, progress narration, or status updates unless the
  user directly asks for them, or in the final closeout.
- Use subagents for implementation, test, and review changes. Give each
  subagent a disjoint write scope and verify no two agents edit the same files.
- The parent agent coordinates, assigns scopes, integrates results, and handles
  final verification. It should avoid broad direct edits except for narrow
  integration fixes that cannot be cleanly delegated.

## Product Contract

Before every live agent turn, Gantry builds a transient context packet:

- Channel message: current message plus the last 30 stored top-level messages
  before it.
- Thread/reply-chain/topic message: thread root plus up to 50 stored messages
  with the same canonical `thread_id`.
- Long thread/reply-chain/topic: root plus first 10 replies plus latest 39
  replies, deduped and ordered.
- Existing Gantry continuity/memory stays separate and is injected through the
  existing turn-context path.

This context packet is prompt input only. Do not persist raw context as memory.
Do not expose raw provider payloads, ids, JSON, or diagnostic text to users.
When a selected current, channel, thread, reply-chain, or topic message has
`NewMessage.attachments`, include bounded XML child descriptors inside that
message so image-only or file-only turns are not invisible. The descriptor
format is:
`<attachment kind="..." content_type="..." size_bytes="..." gantry_ref="..." />`.
Omit absent attributes, omit provider/external ids, escape XML, and include
`gantry_ref` only when an existing relative Gantry attachment ref is already
present.

## Current Repo Truth To Preserve

- Runtime currently collects pending messages in
  `apps/core/src/runtime/group-processing.ts` and sends one flat prompt.
- `apps/core/src/messaging/router.ts` currently formats one flat `<messages>`
  block; add a sectioned formatter instead of overloading the existing one for
  every caller.
- `RuntimeMessageRepository.getMessagesSince(...)` supports forward cursor
  reads only; add the smallest repository reads needed for context windows.
- Slack already maps `thread_ts` to canonical `thread_id`.
- Teams already carries inbound `threadId`.
- Telegram already maps `message_thread_id` to `thread_id`; Telegram cannot
  backfill arbitrary old topic history through Bot API, so use stored messages
  only.
- Discord currently treats `channel_id` as the conversation and does not set
  `thread_id`; for Discord thread channels, resolve the parent channel and store
  the thread channel id as canonical `thread_id`.
- Anthropic SDK and DeepAgents resume/checkpoint state help execution
  continuity, but Gantry still owns external conversation truth.

## Implementation Tasks

1. Add a provider-neutral context selector.
   - Input: conversation JID, active thread id if any, latest triggering
     message, timezone, and message repository.
   - Output: sectioned context data with `recentChannelContext`,
     `activeThreadContext`, `currentMessages`, and metadata counts.
   - Keep constants internal for v1: channel limit 30, thread limit 50, long
     thread first 10 plus latest 39.

2. Add narrow message repository reads.
   - Read last N top-level inbound messages before a cursor/message.
   - Read first N messages in a thread.
   - Read latest N messages in a thread before or up to the triggering message.
   - Reuse existing canonical message mapping and indexes where possible.
   - Do not add tables unless a focused test proves the current schema cannot
     support the reads.

3. Update prompt formatting.
   - Produce explicit sections:
     - `<recent_channel_context>`
     - `<active_thread_context>`
     - `<current_message>`
   - Keep all message content XML-escaped.
   - Render message attachments as bounded escaped child descriptors, not raw
     media, provider ids, local absolute paths, provider JSON, or diagnostics.
   - Mark context as untrusted conversation data, not system authority.
   - Keep command/session flows compatible; do not rewrite unrelated prompt
     formats.

4. Wire the selector into live turn processing.
   - Build the context packet after trigger admission and before `runAgent`.
   - Pass the current message as the final section.
   - Feed a bounded recall query from current message plus selected context, but
     do not save raw selected context as memory.
   - Keep `requiresTrigger` behavior unchanged.

5. Add adapter hydration only where provider APIs support it.
   - Slack: hydrate missing context with `conversations.history` and
     `conversations.replies`.
   - Teams: hydrate missing context with Microsoft Graph channel messages and
     replies.
   - Discord: hydrate missing context with `GET /channels/{id}/messages`;
     resolve thread parent for thread channels.
   - Telegram: no history hydration; use stored messages only.
   - All hydrated messages must be persisted as canonical `NewMessage` rows by
     external message id before use.
   - Historical hydration must not bulk-download images, files, or other media;
     use stored attachment descriptors and already-present Gantry attachment
     refs only.
   - If hydration fails, continue with stored context and record diagnostics.

6. Add diagnostics without user noise.
   - Publish or log context source counts, hydration attempted/skipped/failed,
     provider id, conversation id, and thread id.
   - Never log raw message text, secrets, provider session ids, or checkpoint
     blobs.
   - User-facing fallback, only when needed: `I may be missing earlier context
here. Paste the missing detail if it matters.`

## Memory And SDK Rules

- Do not create a new memory feature.
- Do not merge group/channel/topic memory into private user memory.
- Existing continuity/session digest remains the long-term state layer.
- Anthropic SDK: use session resume only after Gantry builds the context packet.
  Keep dynamic channel/thread context outside static/cacheable prompt prefixes.
- DeepAgents: keep LangGraph checkpointing for execution continuity. Always
  inject the fresh Gantry context packet on new runner processes, even when a
  checkpoint is resumed.

## Acceptance Criteria

- Tagging Gantry mid-channel includes the recent channel discussion.
- Tagging Gantry mid-thread/reply-chain/topic includes the root and relevant
  thread/topic context.
- Long threads are bounded and deterministic.
- Slack, Teams, Discord, and Telegram follow the same provider-neutral limits.
- Telegram topics work from stored messages and do not claim old-message
  backfill.
- Discord thread channels are normalized to parent conversation plus
  `thread_id`.
- No provider injects unbounded history.
- Image-only and file-only selected messages appear in prompt context through
  bounded attachment descriptors.
- No user-facing reply contains context dumps, provider ids, JSON, or
  gibberish.
- Historical context hydration does not bulk-download media.
- No new public setting, CLI flag, Control API field, or MCP/admin surface is
  added for this v1.

## Tests Required

Focused unit tests:

- Context selector:
  - mid-channel tag includes last 30 top-level messages plus current message.
  - mid-thread tag includes root plus prior thread messages.
  - long thread returns root plus first 10 plus latest 39.
  - unrelated threads are excluded.
  - Telegram topic uses stored `thread_id` messages only.
  - missing hydration degrades to stored messages.
- Prompt formatter:
  - section ordering is stable.
  - XML escaping works.
  - image/file attachment descriptors are escaped, omit provider ids, and keep
    `<current_message>` last.
  - current message is last.
- Runtime:
  - `requiresTrigger=true` remains unchanged.
  - continuation thread behavior remains unchanged.
  - memory recall query is bounded.
- Adapters:
  - Slack hydration maps `thread_ts`.
  - Teams hydration maps reply chains.
  - Discord thread channel maps to parent conversation plus `thread_id`.
  - Telegram has no hydration hook.

Run the smallest focused tests first, then broader gates:

```bash
npm run test:unit -- apps/core/test/unit/runtime/group-processing.test.ts
npm run test:unit -- apps/core/test/unit/messaging/formatting.test.ts
npm run test:unit -- apps/core/test/unit/channels/slack.test.ts apps/core/test/unit/channels/teams.test.ts apps/core/test/unit/channels/discord.test.ts apps/core/test/unit/channels/telegram.test.ts
npm test
```

If repository reads or Postgres behavior change, also run a disposable Postgres
check with `GANTRY_TEST_DATABASE_URL` and required `vector` plus `pg_trgm`
extensions:

```bash
npm run test:integration:postgres
```

## Cleanup Searches

Run and interpret these before review:

```bash
rg -n "MAX_MESSAGES_PER_PROMPT|MESSAGE_FETCH_PAGE_SIZE|getMessagesSince\\(" apps/core/src apps/core/test docs -S
rg -n "thread_ts|message_thread_id|reply_to_message_id|referenced_message|thread_id" apps/core/src/channels apps/core/test/unit/channels -S
rg -n "conversation context|recent_channel_context|active_thread_context|current_message" apps/core/src apps/core/test docs -S
```

Expected remaining matches must be current runtime behavior, tests, or this
goal prompt. Remove stale experimental code and dead files.

## Build, Runtime Restart, And Smoke

Use the `runtime-ops-verification` skill.

1. Build first. Do not restart if build fails.

```bash
npm run build
```

2. Restart the local launchd service for this checkout.

```bash
launchctl print gui/$(id -u)/com.gantry
launchctl kickstart -k gui/$(id -u)/com.gantry
```

If the local Gantry CLI is the supported path in the current checkout, this is
also acceptable after the successful build:

```bash
gantry service restart
gantry status
```

3. Confirm runtime health from the built checkout.

```bash
gantry status
gantry jobs list --limit 200
```

4. Run the KnackLabs lead generator smoke test.
   - Discover the job id from the live runtime. Look for a job whose id or name
     includes `knacklabs`, `knack`, or `lead`.
   - Show the job first:

```bash
gantry jobs show <job_id>
```

- If setup/capability/auth is blocked, report the exact blocker and do not
  bypass product permission flows by editing DB/settings directly.
- Trigger the job:

```bash
gantry jobs trigger <job_id>
```

- Poll events until the run reaches a terminal state:

```bash
gantry jobs events <job_id> --full --limit 100
```

- Smoke passes only if the job starts and reaches a successful terminal
  result, or if a real external dependency blocks it with a clear user-action
  blocker.

## Review And PR Closeout

Use the `autoreview` skill after code, tests, build, runtime restart, and smoke
verification.

```bash
.agents/skills/autoreview/scripts/autoreview --mode local
```

If the helper path is unavailable, use the installed autoreview helper from the
skill instructions. Accept only concrete findings. Fix accepted findings, rerun
focused tests, and rerun autoreview until there are no accepted/actionable
findings.

Before creating the PR:

```bash
python3 .codex/scripts/check_architecture.py
python3 .codex/scripts/check_task_completion.py
git status --short
```

Commit only files intentionally changed for this goal. Do not revert unrelated
local changes from other agents.

Create the PR at the end:

```bash
git status --short
git add <changed-files-for-this-goal>
git commit -m "Add provider-neutral conversation context"
git push -u origin HEAD
gh pr create --fill
```

The PR body must include:

- summary of runtime/repository/adapter changes;
- exact tests and verification commands;
- launchd restart evidence;
- KnackLabs lead generator smoke result;
- autoreview command and clean result;
- remaining risks, if any.

## Surface Impact Matrix

| Surface                      | Impact                            | Contract                                                                     |
| ---------------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| Runtime behavior             | Changed                           | Build bounded context packet before live agent prompt.                       |
| `settings.yaml`              | Unchanged by design               | No v1 setting for limits or provider behavior.                               |
| Postgres/runtime projection  | Changed                           | Add/read canonical message windows; persist hydrated provider messages.      |
| Control API                  | Unchanged by design               | No new public API surface.                                                   |
| SDK/contracts                | Changed only if needed internally | Prompt context remains host-owned; provider SDK contracts stay hidden.       |
| CLI                          | Unchanged by design               | CLI is only used for verification/job smoke.                                 |
| Gantry MCP tools/admin skill | Unchanged by design               | No new authority surface.                                                    |
| Channel/provider adapters    | Changed                           | Add bounded hydration hooks for Slack, Teams, Discord; Telegram stored-only. |
| Docs/prompts                 | Changed                           | Document the context packet and provider limits.                             |
| Audit/events                 | Changed                           | Add diagnostics/counts, no raw text.                                         |
| Tests/verification           | Changed                           | Add selector, formatter, adapter, runtime, and smoke verification.           |

## Locked Decisions

- One provider-neutral runtime rule.
- No replay-all-history mode.
- No Slack-only fix.
- No new memory system.
- No new setting unless a failing test proves hard-coded v1 limits are unsafe.
- No user-visible debug/context dumps.
- No direct DB/settings edits to satisfy the KnackLabs job smoke.
