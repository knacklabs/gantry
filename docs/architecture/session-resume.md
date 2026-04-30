# Session Resume

Postgres is the source of truth for MyClaw-owned session identity, memory,
messages, runs, jobs, and runtime events. It is not used to replay transcripts
into every prompt.

For normal chat, continuity is live-process continuity: MyClaw keeps one Claude
Agent SDK streaming-input query open for the active chat runner and pipes
follow-up messages into that stream at safe turn boundaries. That preserves SDK
in-memory conversation context without provider JSONL resume and without
injecting Postgres summaries or recent messages on each turn.

At run start, MyClaw resolves the canonical `AgentSession` from the app, agent,
conversation, thread, and group scope, then hydrates only durable memory scoped
to the agent, user, conversation, and thread. The injected
`<myclaw_memory_context>` block is untrusted evidence only. It does not grant
instruction authority, tool permissions, credentials, or sandbox access. If no
memory exists, no memory context block is injected.

Claude Agent SDK sessions are ephemeral. Runtime code must set SDK session
persistence off, must not pass SDK `resume`, `resumeSessionAt`, or `continue`,
and must not store SDK `newSessionId` as MyClaw session state.

Provider transcript artifacts may exist for explicit export or debugging, but
they are not a continuation mechanism. Jobs use the same durable memory context
path as fresh chat runs; `jobs.session_id` is control/app correlation only and
must never be passed to a provider SDK as a resume handle.

Claude memory hooks are not installed in materialized runtime settings. They
would create a second prompt-injection path and depend on provider JSONL
transcripts, so durable recall must flow through MyClaw memory context and
memory tools only.

`/compact` is a MyClaw control command that forwards the literal `/compact`
slash command to the Claude Agent SDK for provider-owned context-window
compaction inside the active streaming session. MyClaw runs durable memory
extraction with the `precompact` trigger but does not create a Postgres summary
for prompt replay.

Automatic context-window compaction remains provider-owned. The Claude Agent SDK
compacts when the active context approaches the model window and may emit
`compact_boundary` messages during a run. MyClaw must not add another
token-window compactor or install `PreCompact`/`PostCompact` hooks.

Postgres messages and runs remain durable audit and UI state. They are not
automatically injected into prompts as session summaries, recent messages, or
recent run summaries. After a process restart or idle expiry, the next run
starts a fresh ephemeral SDK session and restores only durable memory.

`/new` runs durable memory extraction with the `session-end` trigger before
clearing the current session scope. SDK automatic compaction remains
provider-owned, but MyClaw observes SDK `compact_boundary` messages and runs
durable memory extraction with the `precompact` trigger for chat and scheduled
job runs.
