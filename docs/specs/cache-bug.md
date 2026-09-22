---
slug: cache-bug
title: cache-bug — Bound provider continuity by adapter lifecycle
status: confirmed
saved: 2026-09-22T12:30:00+00:00
---

# cache-bug — Bound provider continuity by adapter lifecycle

## Why

Gantry already rebuilds a bounded prompt from durable channel/thread messages
and durable memory whenever a new interactive runner starts. It also persisted
the provider's session handle and resumed that private transcript. For Claude,
every cold runner therefore appended another bounded briefing to an unbounded
SDK transcript. A one-word Slack turn was observed reading roughly 270k cached
input tokens on each of two model calls.

The earlier containment work added an observed context high-water mark, a
150,000-token default ceiling, fenced retirement, and observability.
Adapter cleanup under decision 0159 is still pending. The shipped controls
remain useful for adapters whose durable session
state Gantry owns, especially DeepAgents. They do not make Claude's opaque SDK
transcript a good cross-process continuity store.

Claude and DeepAgents have different continuity semantics:

- a Claude SDK session is useful while its runner process is alive, where the
  existing IPC loop sends follow-ups to the same query;
- a DeepAgents checkpoint is Gantry-owned durable state and may continue across
  runner processes under the existing ceiling and cleanup rules.

Scheduled jobs already run non-persistent sessions and remain out of scope.

This spec supersedes the Claude cross-process-resume requirements in decision
0158. Decision 0163 is the governing replacement. Decisions 0159 and 0160 and
the already-shipped provider-session ceiling remain active where applicable.

This linked spec is the story's requirements authority. The roadmap card's
intake criteria predate the recorded grill resolutions and decision 0163;
they are historical intake, not a requirement to retain Claude resume.
The already-shipped T1/T2 contracts remain immutable. Pending adapter cleanup
and settings DTO work remain separately owned by T3/T4, outside this fix.

## Behaviour

1. **Adapter-owned continuity policy.** `AgentExecutionAdapter` declares
   whether its interactive provider sessions are `runner_lifetime` or
   `cross_process`. Core runtime branches only on that capability; it does not
   name Claude, DeepAgents, or a provider's storage implementation.
2. **Claude is runner-lifetime.** The Claude adapter declares
   `runner_lifetime`. A new runner never receives a persisted Claude resume
   handle and Gantry never persists a replacement Claude handle for a future
   runner. Interactive Claude runs set `persistSdkSession: false`, so the SDK
   writes no resumable transcript to disk. The existing live IPC query remains
   unchanged, so follow-up messages handled by that runner keep the SDK's tool
   and conversational context while the process is alive.
3. **Cold-run reconstruction.** After a Claude runner exits or the service
   restarts, the next runner starts a new SDK session from the ordinary bounded
   channel/thread snapshot plus durable memory and the pending message. No
   provider transcript, semantic capsule, or raw tool trace is copied.
4. **Rollout retirement.** If a cold run finds a pre-existing active or ready
   Claude handle, it retires that row through the generation-fenced provider
   retirement path before invoking the adapter. An already-running maintenance
   task keeps ownership of its locked row and may finish or time out; the cold
   runner never resumes its handle. A resulting ready handle is retired on a
   later cold encounter. This change does not cancel in-flight maintenance.
   The retirement is observable as
   `session.provider.retired` with reason `runner_lifetime`. Losing the fence
   cannot restore or persist a Claude handle for the stale generation.
5. **DeepAgents is unchanged.** The DeepAgents adapter declares
   `cross_process`. Its checkpoint resume, context high-water mark, and
   threshold retirement continue as implemented. Adapter-owned checkpoint
   cleanup is not expanded by this continuity fix.
6. **Threshold remains.** `limits.provider_session_max_input_tokens` remains a
   global 20,000–900,000 setting with default 150,000. It governs adapters that
   declare cross-process continuity. Claude's live runner remains bounded by
   its existing idle lifecycle and SDK compaction; Gantry does not add a second
   model call or a mid-query rollover protocol in this change.
7. **Delivery and durable truth.** The channel message and completed assistant
   output remain persisted through the existing canonical paths. Retiring an
   opaque Claude handle does not delete messages, memory, runtime events, or
   artifacts. A later runner can know only durable Gantry state—not unpersisted
   details that existed solely inside Claude's private tool trace.
8. **Provider-session commands.** Explicit maintenance compaction must not
   attempt to resume a runner-lifetime Claude handle or enqueue a separate
   Claude maintenance run. It returns a provider-neutral acknowledgement that
   the live SDK owns compaction and the next cold runner starts from bounded
   Gantry context. Existing DeepAgents maintenance behaviour remains unchanged.

## Acceptance criteria

1. Adapter contract tests require an explicit continuity policy for every
   registered execution adapter; Claude is `runner_lifetime` and DeepAgents is
   `cross_process`.
2. Host tests prove a stored Claude handle is generation-fenced retired before
   invocation, no resume id reaches `runAgent`, no replacement handle is
   persisted, run metadata carries no Claude provider-session id, and the
   bounded prompt and hydrated memory still reach the new runner.
3. A lost retirement race re-reads without another memory hydration while the
   canonical session identity is unchanged. If reset changes that identity,
   discard the carried memory and rehydrate under decision 0078. Neither path
   can resume or persist a Claude handle for the stale generation. In-flight
   maintenance retains its existing completion/timeout ownership.
4. Claude runner/IPC integration tests prove same-process follow-ups still use
   the live query and preserve tool context with
   `persistSdkSession: false`.
5. DeepAgents tests prove existing cross-process resume, 150k default ceiling,
   and threshold retirement are unchanged. Checkpoint cleanup remains outside
   this continuity fix.
6. Retirement event tests cover the `runner_lifetime` reason without exposing
   the raw external session id.
7. Scheduled-job tests remain unchanged and green.
8. Architecture and operator documentation describe the provider-specific
   lifecycle and the loss boundary for non-durable Claude tool-trace detail.
9. Deterministic Forge verification and the repository CI suite pass.
10. Each failover attempt recomputes the target adapter's continuity policy.
    Clear the previous provider's handle and run metadata before loading the
    target context; never retire a foreign handle. Test both DeepAgents-to-
    Claude suppression and Claude-to-DeepAgents persistence restoration.
11. Both spawned and inline Claude lanes disable SDK persistence and resume.
    The spawned lane retains live IPC follow-ups; inline control-port behavior
    remains unchanged.
12. Active and idle `/compact` acknowledge runner-managed compaction before
    durable task admission or maintenance locking. Tests prove no task, lock,
    or maintenance runner is created and DeepAgents behavior is unchanged.
13. Runner-lifetime preflight precedes fingerprint/ceiling evaluation and
    compaction-delta replay. Extend fenced retirement to explicitly select a
    ready row (active remains the API default); do not replay that row's delta
    into a fresh bounded prompt. Emit `runner_lifetime` only after successful
    retirement, with canonical session correlation and a hashed handle, no
    raw handle, no runId, and no cap/high-water fields.

## Decision clarification

Accepted `docs/decisions/0164-runner-lifetime-retirement-scope.md` resolves the
requirements review's conflict between lazy Claude retirement and the general
manual-reset rule. It also restates the unchanged cross-process ceiling rules
in the active decision corpus. Plan, task, verification, and review gates
remain required before implementation and shipment.

## Non-goals

- A Claude-authored continuation capsule or any extra handoff model call.
- Session-end digest generation on idle close or a durable active-work
  checkpoint; both remain follow-ups gated on measured continuity loss.
- Copying or replaying raw Claude tool traces.
- A new deterministic tool-outcome projection. Tool idempotency and missing
  durable outcomes are audited separately and added only where evidence shows
  they are required.
- Reworking DeepAgents checkpoints or changing its summarisation policy.
- Changing the bounded briefing contents, memory hydration rules, or scheduled
  job execution.
- Merging the implementation automatically; the task ends at a reviewed,
  CI-green, PR-ready branch.
