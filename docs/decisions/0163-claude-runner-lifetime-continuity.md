---
status: accepted
confirmed_by: "Client (chat approval)"
date: 2026-09-22
stories: [cache-bug]
supersedes: 0158-provider-session-context-ceiling
---

# Claude continuity is runner-lifetime; cold runners rebuild bounded context

## Context

Gantry persisted and resumed Claude Agent SDK session handles across runner
processes. Each cold runner also supplied the ordinary bounded channel/thread
snapshot and durable memory. The bounded briefing was therefore repeatedly
appended to Claude's opaque transcript; production observed roughly 270k
cached input tokens per model call for a one-word Slack turn.

Decision 0158 introduced an observed context ceiling and retirement machinery.
That remains appropriate for Gantry-owned durable checkpoints, but it treats
Claude's private SDK transcript as durable application state and only rotates
it after another expensive turn. Claude already has a better boundary: the
live runner process, whose existing IPC loop accepts follow-up messages without
reconstructing the session.

## Decision

1. The execution-adapter contract declares provider-session continuity as
   either `runner_lifetime` or `cross_process`; core runtime consumes that
   capability without provider-name branching.
2. Claude declares `runner_lifetime`. A new runner does not receive a stored
   Claude resume handle and Gantry does not persist its returned SDK handle for
   a future runner. Same-process IPC continuation is unchanged.
3. A cold Claude runner starts from Gantry's bounded channel/thread snapshot,
   durable memory, and pending message. There is no Claude-authored capsule and
   no raw tool-trace replay.
4. Pre-existing resumable Claude handles are retired lazily on their first
   cold-run encounter using the existing generation fence and a
   `runner_lifetime` retirement reason. A lost fence cannot re-enable resume or
   persistence for the stale generation.
5. DeepAgents declares `cross_process`; its existing checkpoint resume,
   context ceiling (default 150,000), and adapter cleanup remain unchanged.
   The threshold remains a defense for cross-process provider state rather than
   a reason to preserve Claude cross-process resume.
6. Scheduled jobs remain non-persistent. Claude maintenance compaction cannot
   resume a runner-lifetime handle.

## Consequences

- Claude's model-visible history is bounded at process boundaries by Gantry's
  existing briefing and memory limits. It no longer grows across restarts.
- Live follow-ups retain Claude's conversational and tool context for the life
  of the runner. After process loss, only Gantry's durable messages, memory,
  events, and artifacts survive; opaque unpersisted tool-trace detail does not.
- No extra handoff model call, capsule schema, or failure mode is introduced.
- The change is intentionally provider-specific through an adapter capability.
  DeepAgents' Gantry-owned durable checkpoint lifecycle is not weakened.
- This is a breaking continuity change for Claude across runner restarts, but
  not a public API or persisted-message compatibility break.
