---
status: accepted
confirmed_by: "Ravi"
date: 2026-09-09
stories: [cache-bug]
---

# Provider-neutral session-release port: adapters reclaim their own retired session state

## Context

Retiring a DeepAgents provider session (0158, missing-session, fingerprint
change, `/new`) leaves its LangGraph checkpoint rows (`checkpoints`,
`checkpoint_blobs`, `checkpoint_writes`) in the adapter-derived Postgres
schema. No application path owns their deletion, so retired state accumulates
and checkpoint load latency grows. The core runtime is provider-neutral
(BRIEF, 0018) and must not name a checkpoint table. The
`AgentExecutionAdapter` contract has `prepare()` and two optional probes only;
DeepAgents receives its database URL and schema per run through
`runtimeStorage` in `prepare()`. `PostgresSaver.deleteThread(threadId)`
exists in the installed checkpoint package. `resetScope` (the `/new` path)
deletes provider-session rows inside a transaction and returns `void`.

## Decision

1. `AgentExecutionAdapter` gains an optional
   `releaseSession(input: { externalSessionId; runtimeStorage })` capability.
   The host calls it only from a non-empty retirement result, after the
   user's reply path is unblocked, passing the same `runtimeStorage` it passes
   to `prepare()`. The Claude adapter does not implement it.
2. The DeepAgents adapter implements it by deriving the checkpoint schema
   exactly as `prepare()` does (`deepAgentsCheckpointSchema`) and calling the
   saver's `deleteThread(externalSessionId)`. It is idempotent. On failure it
   rejects with a message the host sanitises (no external session id, thread
   id or connection string) before emitting `session.provider.cleanup_failed`;
   the session stays expired.
3. `resetScope` returns the immutable list of retired
   `{ providerSessionId, externalSessionId, executionProviderId,
   agentSessionId }` it removed, materialised inside its transaction and
   returned after commit; the `/new` handler replies, then dispatches
   best-effort release for each.

   AMENDED 2026-09-11 (Ravi, requirements gate): `agentSessionId` was added
   to the reference. The spec requires the `/new` retirement event to carry
   `sessionId`, and the active `/new` path's separate command-boundary lookup
   can fail while the reset itself succeeds — leaving a committed retirement
   that cannot be attributed. Carrying the owning agent-session id out of the
   same committed read removes the guess: the handler publishes one event per
   retired row using the id that row came with.
4. Covered paths: ceiling, missing-session, access-fingerprint change, `/new`.
   Not covered, with retention stated: normal handle replacement (the prior
   row is deleted by `setSession`); agent and workspace removal cascades;
   the compaction-delta replay degradation path
   (`group-agent-runner-compaction-delta.ts`, stale or too-large delta),
   which keeps expiring the session as today but performs no release and
   emits no retirement event; and compaction maintenance failure or
   cancellation, which reactivate the session. Orphans are an operator
   procedure in `docs/memory/`; there is no durable retry system.

## Consequences

- Core stays provider-neutral; provider-specific storage knowledge lives in
  the adapter that created it.
- A process lost between commit and release leaves an orphan the operator
  scan reclaims; accepted in exchange for no retry infrastructure.
- Rejected: a host-owned cleanup service branching on provider id (violates
  the provider-neutral rule); a durable cleanup retry owner (infrastructure
  ahead of demand).
