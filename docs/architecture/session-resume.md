# Session Resume

## Current Contract (Implemented)

Postgres is the source of truth for MyClaw-owned session identity, memory,
messages, runs, jobs, and runtime events. It is not used to replay full
transcripts into prompts.

At run start, MyClaw resolves canonical `AgentSession` identity from app, agent,
conversation, and optional thread scope, then hydrates continuity context:

1. Recent persisted session digests.
2. Durable memory scoped to agent/user/conversation/thread.

`<myclaw_memory_context>` is untrusted evidence only. It does not grant
instruction authority, permissions, credentials, or sandbox access.

## Provider Resume Handles

Provider resume handles are allowed today, but only as adapter metadata
attached to canonical `AgentSession` records.

- Canonical continuity record: `AgentSession` (provider-neutral app contract).
- Adapter projection field: `ProviderSession.externalSessionId`.
- Current runtime projection: Anthropic/Claude adapter consumes
  `turnContext.externalSessionId` and passes it to Claude SDK `query()` as
  `resume` for live chat turns.
- Current runtime also keeps Claude SDK persistence enabled for live chat runs
  (`persistSession: true`) and disables resume for scheduled jobs.

This is a Claude-specific runtime projection. It is not yet a provider-neutral
resume implementation across all model providers.

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
- attach provider resume handles only as owned `ProviderSession` metadata for
  that canonical session.

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

- `/new` does best-effort continuation capture (`session-end` trigger), then
  clears scoped provider-session state.
- Reset preserves canonical `agent_sessions` identity and scoped
  `agent_session_digests`; digest hydration still works after reset.
- During live runs, MyClaw persists newly emitted SDK session ids as soon as
  they stream, not only at runner shutdown. This is restart-safe against host
  restarts that interrupt an active run.
- Expiring or clearing provider-session metadata does not delete canonical
  session identity.

## Artifacts And Non-Goals

- Provider transcript artifacts may exist for export/debug only; they are not
  canonical runtime state.
- Provider artifacts are never a source for continuity import, digest
  hydration, provider-session backfill, or session repair.
- Jobs do not use provider resume handles; `jobs.session_id` remains
  app/control correlation metadata.
- MyClaw does not install provider memory hooks as a second prompt-injection
  path.
- `/compact` remains provider-owned context-window compaction, while MyClaw
  observes `compact_boundary` and captures continuation evidence (`precompact`)
  without replaying transcript summaries into prompts.

## If Policy Changes Back To “No SDK Resume”

That policy is not what the runtime does today. Enforcing it would require
concrete implementation changes in at least:

- `apps/core/src/runtime/group-agent-runner.ts` (stop passing
  `turnContext.externalSessionId` as `sessionId`).
- `apps/core/src/runner/claude/query-loop.ts` (disable `resume` and likely
  `persistSession` for live chat turns).
- Existing tests that assert current resume behavior, including
  `apps/core/test/unit/runtime/group-processing.test.ts` and
  `apps/core/test/unit/runner/agent-runner-ipc.test.ts`.
