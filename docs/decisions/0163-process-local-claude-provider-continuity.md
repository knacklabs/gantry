---
status: accepted
confirmed_by: "Ravi"
date: 2026-09-18
stories: [cache-bug]
---

# Claude provider continuity is process-local; durable context belongs to Gantry

## Context

Decision 0158 bounded persistent provider sessions by retiring them after an
observed context crossing. That contains unbounded growth for adapters whose
provider-side checkpoint is the durable conversation, such as DeepAgents.

Claude's SDK session is different. Gantry already owns the canonical Slack
and thread history, scoped session digests, durable memory, active jobs, and
run evidence in Postgres. Resuming a Claude SDK session in a new runner and
also appending a new bounded briefing duplicates overlapping history. It also
lets the session-bearing SDK transcript survive longer than the runner that
owns its stdin and IPC lifecycle. Prompt caching can make that duplication
cheaper, but it does not make the model-visible context smaller or simpler.

Late and intervening messages do not require a provider resume handle. The
next runner can read the current bounded channel/thread window and therefore
include messages that arrived while no runner was alive. Provider-only facts
that must survive belong in Gantry's digest and memory layers instead of an
opaque Claude transcript.

## Decision

1. Provider adapters declare whether provider-session continuity is
   `process_local` or `durable_resume`. The host selects lifecycle behaviour
   through that capability, never by branching on a provider id.
2. Claude declares `process_local`. A Claude query may continue only while
   its owning runner process is alive. A later worker or inline runner starts
   a fresh non-persistent SDK query with no resume id and reconstructs one
   bounded input from the current channel/thread snapshot, recent scoped
   session digests, active durable memory, and active jobs.
3. Claude provider-session handles are neither persisted nor projected as
   resumable state. Stale Claude provider-session rows are ignored before
   promotion, delta replay, locking, status projection, failover carry-over,
   or run attachment.
4. `/compact` chooses the adapter strategy before provider-session locking.
   For Claude, the durable session-compaction task remains the admission and
   deduplication owner, but the operation creates a fresh checkpoint and
   discards provider context without creating a provider-session lock.
5. Claude session-bearing SDK files are per-runner and removed during normal
   cleanup. Stable SDK configuration, skills, and credentials remain in their
   existing materialized locations.
6. A drained rollout transactionally deletes only Claude execution-provider
   session rows and their latest pointers, and removes legacy Claude
   transcript/session directories. DeepAgents rows and checkpoints survive.
   Runtime ignore rules are the safety boundary if cleanup is incomplete.
7. DeepAgents declares `durable_resume` and retains the ceiling and release
   behaviour from decisions 0158 and 0159, including
   `limits.provider_session_max_input_tokens`.

This decision amends only 0158's Claude-specific cross-process continuity and
its rejection of briefing reconstruction. It does not supersede 0158 for
durable-resume adapters.

## Consequences

- Restarted Claude runners no longer accumulate `A + (A+B) + (A+B+C)` in an
  opaque provider transcript. They receive the newest bounded snapshot once.
- Messages that arrive between runners are included when they fall inside the
  bounded channel/thread window; older durable facts depend on digest and
  memory quality, which is now an explicit Gantry responsibility.
- Claude loses provider-only tool/conversation history on restart. Important
  outcomes must be recorded in Gantry memory, digests, jobs, or canonical run
  evidence rather than relying on the provider transcript.
- Same-process live continuation remains fast and unchanged.
- DeepAgents durable resume, retirement measurement, and checkpoint release
  remain intact.
- Public status and resume projections become capability-aware, preventing an
  incomplete cleanup from making stale Claude rows observable or reusable.
- No new setting is introduced. The 150k ceiling continues to protect
  durable-resume adapters, not process-local Claude sessions.
