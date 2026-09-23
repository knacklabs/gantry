---
slug: process-local-claude-continuity
title: Process-local Claude continuity with fresh cross-runner context
status: confirmed
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

1. Both Claude interactive execution lanes—the worker runner and the inline
   lane—start a fresh, non-persistent Claude SDK query. They receive no
   persisted provider-session resume id and run with `persistSession: false`.
2. Follow-up messages delivered while that runner is alive continue through its
   existing in-process IPC/message stream and the same SDK query. This change
   affects only the boundary after the runner exits, idles out, crashes, or is
   recovered on another worker.
3. A later runner reconstructs model-visible continuity from the existing
   bounded channel/thread context and the current hydrated continuity block:
   recent scoped session digests, active durable Gantry memory, and active job
   context. Runs and runtime events remain canonical evidence but are not
   replayed into the prompt. The new runner never reopens the previous Claude
   SDK transcript.
4. Core runtime chooses this behaviour from an adapter-owned provider-session
   continuity capability. It does not branch on an Anthropic/Claude provider id.
   Claude declares process-local continuity; DeepAgents keeps durable resume and
   its existing checkpoint/ceiling/release lifecycle.
5. The adapter continuity capability is consulted before selecting or promoting
   a provider-session row. For process-local adapters, active, ready, and
   maintenance-compaction rows are ignored before they can mutate lifecycle
   state, replay a compaction delta, affect `/status`, or set
   `hasProviderResume`. Process-local adapters do not persist emitted
   provider-session ids, attach them to canonical runs, raise context marks for
   them, or enter the durable provider-session retirement/cleanup lifecycle.
   The existing ceiling remains unchanged for adapters that support durable
   resume.
6. `/compact` selects the adapter strategy before attempting a provider-session
   lock. For a process-local adapter, the canonical durable session-compaction
   task is the admission and deduplication owner; no provider-session lock is
   required or created. It performs fresh-checkpoint behaviour: capture the
   current canonical memory/session boundary best-effort, discard provider
   context, and let the next turn rebuild fresh. Concurrent commands produce the
   existing already-running response. Durable-resume adapters retain
   provider-owned locking, compaction, and delta replay.
7. Scheduled jobs remain non-persistent and non-resuming exactly as today.
8. Provider-session continuity belongs to the adapter for the active attempt in
   a failover loop. Each attempt independently decides whether it may receive a
   resume id and whether its output may persist a handle, run association, or
   context mark. Claude-to-DeepAgents failover may persist the successful
   DeepAgents checkpoint; DeepAgents-to-Claude failover must not carry or write
   a Claude provider session.
9. Claude session-bearing SDK storage is per-run and removed during normal
   runner cleanup. Stable non-session configuration, skills, and credentials
   remain materialized through their existing paths. Deployment removes legacy
   worker and inline Claude transcript/session files after traffic is drained.
10. Deployment transactionally deletes only Claude execution-provider session
    rows and clears their latest pointers while workers are stopped. DeepAgents
    rows survive. Runtime behaviour independently ignores stale Claude rows, so
    incomplete cleanup cannot reopen or report them; cleanup keeps storage and
    observability honest rather than acting as the correctness guard. Rollback
    starts new Claude contexts—it never restores deleted provider transcripts.
11. No new runtime setting is introduced. `limits.provider_session_max_input_tokens`
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

1. Newly spawned worker and inline Claude interactions set
   `persistSession: false`, receive no `resume` option, and do not receive a
   persisted `AgentInput.sessionId` even when an old Claude provider-session
   row exists.
2. Two messages delivered while one Claude runner remains alive use the same SDK
   query/message stream; the second message does not spawn a fresh runner or lose
   in-process tool/conversation state.
3. Claude interactive outputs do not persist a reusable provider-session
   handle, attach one to the run, or raise a provider-session context mark.
   Existing active, ready, and maintenance-compaction Claude rows are ignored
   before promotion, delta replay, run attachment, status projection, and
   resume-state projection.
4. A simulated runner restart starts fresh and receives the bounded
   channel/thread snapshot plus explicit hydrated sections for recent scoped
   session digests, active durable memory, and active jobs. Runs and runtime
   events are not replayed as prompt context.
5. DeepAgents interactive sessions still persist and resume their provider
   session/checkpoint and remain governed by the existing context ceiling and
   release lifecycle.
6. Scheduled Claude and DeepAgents jobs retain their current non-persistent,
   non-resuming behaviour.
7. `/compact` selects fresh-checkpoint strategy for Claude before lock
   acquisition, admits and deduplicates through the durable compaction task when
   no provider row exists, reports concurrent requests as already running, and
   emits ready or degraded receipts without stranding the conversation.
   Durable-resume adapters retain their current provider-compaction path.
8. Failover tests prove that the adapter for each attempt independently owns
   resume input and output persistence: Claude-to-DeepAgents can persist the
   successful checkpoint, while DeepAgents-to-Claude cannot pass or persist a
   Claude handle. Run metadata and context marking identify the successful
   durable attempt only.
9. Claude worker and inline session-bearing SDK storage is per-run and cleaned
   up, while stable non-session configuration and skills remain available.
   Legacy transcript/session directories are included in drained rollout
   cleanup.
10. Operator documentation contains one transactional, Claude-only deletion
    procedure with workers stopped, pointer cleanup, a stop condition proving no
    Claude resumable rows or legacy session files remain, an assertion that
    DeepAgents rows survived, rollback guidance, and an observation query
    showing Claude runs no longer acquire reusable provider-session handles.
11. Public session resume projections and `/status` exclude process-local
    provider-session rows even when cleanup was incomplete; durable-resume
    adapters retain current reporting.
12. A new accepted decision and repository-wide documentation reconciliation
    describe provider sessions as adapter optimizations whose continuity
    lifetime is declared by the adapter. The decision supersedes only decision
    0158's Claude-specific cross-process continuation and rejected-alternative
    language, preserving its ceiling for durable-resume adapters. Reconciled
    surfaces include session resume, runtime components, canonical domain model,
    runtime guidance, operations, and tests that currently assert stable Claude
    transcript persistence.
13. Focused provider-session, group-processing, worker and inline Claude SDK
    boundary, compaction, failover, read-model, DeepAgents-resume, storage
    cleanup, and scheduled-job tests pass, followed by the deterministic Forge
    verification gate and one three-lens autoreview.
