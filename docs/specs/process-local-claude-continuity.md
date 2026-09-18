---
slug: process-local-claude-continuity
title: Process-local Claude continuity with fresh cross-runner context
status: draft
saved: 2026-09-18T06:35:08+00:00
---

# Process-local Claude continuity with fresh cross-runner context

## Why

Gantry currently combines two continuity mechanisms on every new interactive
runner: it resumes a persisted Claude Agent SDK session containing the full
provider transcript, then appends a newly reconstructed bounded channel/thread
snapshot and Gantry memory block. Each briefing is bounded, but the resumed
provider transcript accumulates overlapping copies of those briefings until the
provider-session ceiling retires it. Anthropic prompt caching discounts repeated
prefixes; it does not remove them from model-visible context.

The existing 150,000-token ceiling is a necessary safety fuse but remains a
retire-after-observed-crossing rule. A new runner can still reopen and reread a
large provider transcript before the next-resume retirement occurs. Gantry
already owns canonical continuity in Postgres through messages, recent session
digests, durable memory, runs, and events. Claude provider sessions should
therefore be process-local execution state rather than cross-process continuity.

## Behaviour

1. A Claude interactive runner starts a fresh, non-persistent Claude SDK query.
   It receives no persisted provider-session resume id and runs with
   `persistSession: false`.
2. Follow-up messages delivered while that runner is alive continue through its
   existing in-process IPC/message stream and the same SDK query. This change
   affects only the boundary after the runner exits, idles out, crashes, or is
   recovered on another worker.
3. A later runner reconstructs continuity from the existing bounded
   channel/thread context, recent scoped session digests, and durable Gantry
   memory. It never reopens the previous Claude SDK transcript.
4. Core runtime chooses this behaviour from an adapter-owned provider-session
   continuity capability. It does not branch on an Anthropic/Claude provider id.
   Claude declares process-local continuity; DeepAgents keeps durable resume and
   its existing checkpoint/ceiling/release lifecycle.
5. Process-local adapters do not persist emitted provider-session ids, attach
   them to canonical runs, raise context marks for them, or enter the durable
   provider-session retirement/cleanup lifecycle. The existing ceiling remains
   unchanged for adapters that support durable resume.
6. `/compact` for a process-local adapter performs the existing fresh-checkpoint
   behaviour: capture the current canonical memory/session boundary best-effort,
   discard provider context, and let the next turn rebuild fresh. It must not
   require or create a provider-session maintenance lock. Durable-resume adapters
   retain provider-owned compaction and delta replay.
7. Scheduled jobs remain non-persistent and non-resuming exactly as today.
8. Deployment uses a drained-runtime cleanup to remove or expire existing
   Claude provider-session handles. Runtime behaviour also ignores any stale
   Claude handle, so an incomplete cleanup cannot reopen it; the cleanup keeps
   storage and observability honest rather than acting as the correctness guard.
9. No new runtime setting is introduced. `limits.provider_session_max_input_tokens`
   remains available for durable-resume adapters.

Provider-only transcript details outside the bounded message window and the
latest available Gantry digests/memory are not guaranteed after a runner exits.
This is an explicit trade-off of predictable bounded context. Automatic new
digest extraction on every idle/crash boundary is not included: it would add an
LLM extraction cost, deduplication protocol, and crash-boundary semantics beyond
this replacement. Revisit it only if production continuity evidence shows the
existing snapshot, digest, and memory inputs are insufficient.

Late channel events persisted behind the existing `(timestamp, id)` admission
cursor are also outside this change. Fresh provider context does not repair a
message that canonical admission never selected; that requires a separate
ingestion-order contract.

## Acceptance criteria

1. A newly spawned interactive Claude runner sets `persistSession: false`,
   receives no `resume` option, and does not receive a persisted
   `AgentInput.sessionId` even when an old Claude provider-session row exists.
2. Two messages delivered while one Claude runner remains alive use the same SDK
   query/message stream; the second message does not spawn a fresh runner or lose
   in-process tool/conversation state.
3. Claude interactive outputs do not persist a reusable provider-session handle,
   attach one to the run, or raise a provider-session context mark. Existing
   stale Claude handles cannot be resumed.
4. A simulated runner restart starts fresh and receives the bounded
   channel/thread snapshot plus the hydrated recent session-digest and durable
   memory block.
5. DeepAgents interactive sessions still persist and resume their provider
   session/checkpoint and remain governed by the existing context ceiling and
   release lifecycle.
6. Scheduled Claude and DeepAgents jobs retain their current non-persistent,
   non-resuming behaviour.
7. `/compact` on Claude completes through fresh-checkpoint memory capture without
   a provider-session maintenance lock; failure to capture memory is reported as
   degraded but does not strand the conversation. Durable-resume adapters retain
   their current provider-compaction path.
8. Operator documentation contains the drained-runtime rollout cleanup, a stop
   condition verifying no resumable Claude interactive rows remain, rollback
   guidance, and an observation query showing Claude runs no longer acquire
   reusable provider-session handles.
9. The session-resume architecture and a new accepted decision describe provider
   sessions as adapter optimizations whose continuity lifetime is declared by the
   adapter; the new decision amends only the cross-process Claude clauses of
   decision 0158 and preserves its ceiling for durable-resume adapters.
10. Focused provider-session, group-processing, Claude SDK boundary, compaction,
    DeepAgents-resume, and scheduled-job tests pass, followed by the deterministic
    Forge verification gate and one three-lens autoreview.
