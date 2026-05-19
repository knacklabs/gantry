# Session Resume

## Current Contract (Implemented)

Postgres is the source of truth for Gantry-owned session identity, memory,
messages, runs, jobs, and runtime events. It is not used to replay full
transcripts into prompts.

At run start, Gantry resolves canonical `AgentSession` identity from app, agent,
conversation, and optional thread scope, then hydrates continuity context:

1. Recent persisted session digests.
2. Durable memory scoped to agent/user/conversation/thread.

`<gantry_memory_context>` is untrusted evidence only. It does not grant
instruction authority, permissions, credentials, or sandbox access.

## Provider Session Metadata

Provider session handles may exist as adapter metadata attached to canonical
`AgentSession` records. Live user-facing turns use those handles only as an
adapter resume optimization; canonical continuity still belongs to Postgres.

- Canonical continuity record: `AgentSession` (provider-neutral app contract).
- Adapter projection field: `ProviderSession.externalSessionId`.
- Current live runtime projection: Anthropic/Claude SDK runs set
  `persistSession: true` and pass `resume` from the trusted
  `AgentInput.sessionId` when a provider handle exists.
- Current scheduled/autonomous job projection: jobs set `isScheduledJob: true`,
  do not pass `AgentInput.sessionId`, and the Claude SDK query runs with
  `persistSession: false`.
- Conversation evidence belongs in Postgres messages, runs, jobs, memory,
  digests, and runtime events; provider JSONL files are not continuity state.

This keeps normal agent conversations canonically provider-neutral while
allowing live runs to use the provider's own efficient resume path. If
transcript export is needed, generate it from Postgres evidence into a
FileArtifact instead of depending on provider-local session files.

## Scope And Ownership Isolation

Provider-session metadata is scoped by canonical route/session keys and
ownership checks:

- Authoritative session scope: `scope_key` on the canonical `AgentSession`.
- Authoritative digest visibility: digest queries filter by the resolved
  canonical scope plus digest scope fields, not by provider transcript shape or
  historical id patterns.
- Scope key shape: `<agentFolder>::conversation:<jid>` plus either:
  - `::user:<providerUserId>` for DM scope, or
  - `::thread:<providerThreadId>` for thread/topic scope.
- Rebinding a conversation to a different agent yields a different canonical
  `AgentSession`; prior provider session handles do not carry over.
- A provider session id already owned by one `AgentSession` cannot be attached
  to another.
- Unsafe provider session ids are rejected before persistence.

## Unsupported Legacy Continuity Rows

Old continuity rows that do not satisfy the current `scope_key`, digest-scope,
and provider-session ownership rules are unsupported state. Runtime and
repository code must fail closed for those rows: do not import them into current
continuity, do not synthesize current scope keys from historical identifiers,
do not backfill them into `agent_sessions` or `agent_session_digests`, and do
not repair them during normal startup, reset, or resume flows.

This is a clean-cut contract. The only supported current continuity paths are:

- resolve or create the canonical `AgentSession` for the current app, agent,
  conversation, and optional thread/user scope;
- hydrate recent digests through canonical digest scope filtering;
- treat provider-session rows only as owned adapter metadata for that canonical
  session, not as resume authority.

If a development database still contains old compatibility rows, the correct
cleanup is an explicit local reset or one-off operator action outside the
runtime path. The product runtime must not ship compatibility import,
fallback, or repair branches for that state.

## Privacy And Exposure Constraints

- Provider session handles are treated as sensitive runtime metadata.
- Session APIs redact direct provider-session identifiers from default session
  detail payloads; callers get summarized state (`hasProviderResume`) instead of
  raw `externalSessionId`.
- Runner logs redact provider session handles.

## Reset And Restart Behavior

- `/new` captures the old canonical session boundary, clears scoped
  provider-session state, and finalizes continuation capture (`session-end`
  trigger) in the background. A slow extractor must not block the fresh session
  reset.
- Reset preserves canonical `agent_sessions` identity and scoped
  `agent_session_digests`; digest hydration still works after reset.
- During live runs, Gantry persists canonical messages, runs, jobs, memory,
  digests, and runtime events. Newly emitted SDK session ids are sensitive
  adapter metadata attached to the canonical session, not standalone continuity
  identity.
- Expiring or clearing provider-session metadata does not delete canonical
  session identity.

## Artifacts And Non-Goals

- Provider transcript artifacts may exist for export/debug only; they are not
  canonical runtime state.
- Provider artifacts are never a source for continuity import, digest
  hydration, provider-session backfill, or session repair.
- Jobs do not use provider resume handles; `jobs.session_id` remains
  app/control correlation metadata.
- Gantry does not install provider memory hooks as a second prompt-injection
  path.
- `/compact` remains provider-owned context-window compaction, while Gantry
  observes `compact_boundary` and captures continuation evidence (`precompact`)
  without replaying transcript summaries into prompts.

## Runtime Guardrails

- `apps/core/src/adapters/llm/anthropic-claude-agent/runner/index.ts` must pass explicit query-loop SDK
  persistence options: live turns persist/resume, scheduled jobs do not.
- Host live runner inputs may pass the trusted `turnContext.externalSessionId`
  as `AgentInput.sessionId`; scheduler execution must not copy
  `jobs.session_id` or `executionContext.sessionId` into that field.
- Tests should assert live turns set `persistSession: true` and `resume` when
  `AgentInput.sessionId` exists, while scheduled jobs run with
  `persistSession: false` and no `resume` options. Postgres remains the
  canonical evidence path for messages, runs, memory, jobs, and events.
