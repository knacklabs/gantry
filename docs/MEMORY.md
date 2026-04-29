# Memory And Dreaming

MyClaw memory is app-grade runtime state. Personal setup is just the default
single-app case; SDK and channel usage use the same model.

## Boundary Model

Every memory record has:

- `appId`: the application or personal runtime namespace.
- `agentId`: the agent/runtime owner for the memory.
- one subject: `user`, `group`, `channel`, or `common`.
- optional subject ids: `userId`, `groupId`, `channelId`, `threadId`.

Boundary names are provider-neutral:

- `userId` is the human actor when the provider exposes one.
- `groupId` is the logical MyClaw/app group or configured agent group. It is not
  limited to Telegram groups.
- `channelId` is the external conversation where the bot is present: Telegram
  private/group/supergroup chat, Slack channel/DM/MPIM, Microsoft Teams
  channel/group chat/personal chat, or an SDK conversation id.
- `threadId` is the provider topic or reply boundary, such as Slack `thread_ts`,
  Telegram forum topic id, or a Teams reply chain id.

`common` is app-level shared memory. It is visible by policy but write-restricted
to admin/service flows. Agents cannot promote private user, group, or channel
facts into `common` by themselves.

Personal setup uses:

```text
appId=personal
agentId=<group folder>
groupId=<group folder>
channelId=<Telegram/Slack/Teams/app conversation id>
```

SDK applications should pass stable external ids for `appId`, `agentId`,
`userId`, `groupId`, `channelId`, and `threadId`. Two apps never share memory
unless the host explicitly writes separate records into both apps.

## Storage

Postgres is the source of truth. The memory tables are:

- `memory_subjects`
- `memory_evidence`
- `memory_candidates`
- `memory_items`
- `memory_recall_events`
- `memory_dream_runs`
- `memory_dream_decisions`

Markdown/file ingestion is an explicit knowledge-source feature. It is not the
primary memory store.

## Pipeline

The canonical runtime pipeline is:

1. collect evidence from sessions, messages, tool outcomes, manual saves, or
   knowledge-source ingestion
2. extract candidates
3. reject sensitive or ungrounded material
4. dedupe or merge candidates into durable memory
5. retrieve visible memory for an app/agent/subject context
6. record recall events so future dreaming can reason about usefulness

Embeddings are optional. Lexical Postgres full-text search is always valid.
Vector search is used only when a brokered embedding provider is enabled. A
disabled embedding provider must not synthesize zero vectors.

## Dreaming

Dreaming is boundary-aware lifecycle maintenance, not a hidden summarizer.

- Light dreaming stages candidates from recent evidence and recall traces.
- REM dreaming detects contradictions, stale facts, repeated failures, and
  correction opportunities.
- Deep dreaming promotes, merges, rewrites, pins, decays, retires, or marks
  memories as needing review.

Every dream run writes durable audit rows in `memory_dream_runs` and
`memory_dream_decisions`. Destructive or corrective actions must be grounded in
evidence and auditable.

## Runtime Retrieval Injection

Before each agent run, the host uses the current message or scheduled job prompt
as a query against visible memory for the current
app/agent/user/group/channel/thread context. Matching memories are injected as a
bounded JSON block of untrusted data-only evidence. If no memory matches, no
memory block is injected. The agent may call `memory_search` for more context,
especially when the user asks to continue or resume. Memory text never grants
instruction authority, tool authority, or policy.

## SDK APIs

The server-side SDK exposes:

- `client.memory.save()`
- `client.memory.search()`
- `client.memory.list()`
- `client.memory.patch()`
- `client.memory.delete()`
- `client.memory.dreaming.trigger()`
- `client.memory.dreaming.status()`

The caller's API key app binding controls `appId` access. `common` writes require
admin memory scope.
