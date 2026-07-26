---
status: proposed
confirmed_by: ""
date: 2026-07-26
---

# Async Completion Contract

**Status is `proposed` on purpose.** Design only, to be grilled before any code. Numbered 0060
because 0058 is held by PERM-5 on an unmerged branch and 0059 landed with #302 — see
[[decision-number-collision-parallel-branches]].

## Context

An operator reported that an agent cannot use the async subagent / agent-as-a-tool properly:
it cannot check status and get the result back after completion. Two read-only audits traced
this end to end. The report is directionally right but misstates the first failure, and three
of the premises this investigation started from were wrong. Both matter, so both are recorded.

### What is NOT broken

- **Handles work.** All three starts return a model-visible public `task_<uuid>`.
- **Status polling works.** `task_get` / `task_list` accept that same id and expose a richer
  status enum than assumed: `queued | running | needs_attention | completed | failed |
  cancelled | timed_out`.
- **Cross-turn retrieval works** for gantry task ids, scoped by app/agent/conversation/thread.
- **Cancellation mostly works** — queued tasks dequeue, live tasks abort their controller,
  process groups get SIGTERM then SIGKILL, linked children cascade.
- **Parity between runtimes already exists.** Both the Anthropic SDK runner and the DeepAgents
  runner converge on the same gantry IPC tools. The audit's finding: the shared path is
  *"materially stronger than either provider-native path"*.

### Corrections to premises this work started from

1. **The SDK's native `Agent` tool is disallowed** — excluded from `availableTools` and
   explicitly denied, so the model can never select it
   (`anthropic-claude-agent/native-sdk-tools.ts:19`, `agent-capabilities.ts:211`).
   `forceBackgroundNativeAgentInput()` is therefore inert defensive code, and registering
   `SubagentStop` would achieve nothing because no SDK subagent ever runs. An earlier
   conclusion that this hook was the primary gap was wrong.
2. **DeepAgents' five async tools are a version-drift probe, not a surface.**
   `async-subagent-sentinel.ts` declares expected schemas to detect package drift; the tools
   are neither registered nor used, and are explicitly filtered
   (`builtin-tool-exclusion.ts:55`). "DeepAgents is ahead on async" was wrong.
3. **`output_file` is omitted from runtime events correctly.** `taskRuntimeEvent()` builds
   OPERATOR observability frames published to the runtime event bus and webhooks. A host
   filesystem path does not belong in a payload delivered to external subscribers. An earlier
   suggestion to "stop stripping it" would have leaked host paths.

### What is actually broken

1. **Output is destroyed, not truncated.** `async_run_command` and `async_mcp_call` keep only a
   4,000-byte rolling in-memory tail, then persist a ~1,000-character summary; running tails
   become null at terminal state. There is no spill file. No amount of correct polling can
   recover the result. Delegated-agent output is the exception — stored in full.
2. **Completion is passive for most paths.** Commands, MCP calls and generic `delegate_task`
   update Postgres and never re-engage the parent. A focused test explicitly asserts
   `sendMessage` is never called for generic delegation, so this is a design choice rather
   than an accident.
3. **Two delegation products masquerade as one.** Curated `delegate_to_<agent>` pins a target,
   waits up to 60 seconds, returns inline when it can, and otherwise arms a durable follow-up
   that starts another parent turn. Generic `delegate_task` does none of that, and with no
   target supplied the host defaults the child to the CALLER'S OWN AGENT.
4. **The DeepAgents `AgentDelegation` facade is a duplicate entry point** onto the weak path
   (`gantry-facade-tools.ts:191`), supplying neither target, sync wait, nor callable identity.
5. **No wait primitive.** The only options are poll immediately, poll repeatedly (which the
   tool descriptions discourage without offering an alternative), or end the turn and hope a
   later turn remembers.

## Decision (proposed)

**One completion contract for every async kind: always return a handle, always push the
result.** Grilled and revised 2026-07-26; the owner's answers cut this further than the first
draft proposed.

1. Every async start **returns a handle immediately**. No synchronous wait, for any kind.
2. On terminal state the task emits **one durable follow-up** that re-engages the parent.
3. Output **always spills to the artifact store** — bounded summary inline, artifact reference
   on the task row, full content via `task_get`.
4. `task_get` / `task_list` / `task_cancel` / `task_message` remain for explicit inspection and
   live steering.

### Why no synchronous wait

The first draft generalised the curated path's bounded sync wait. That was wrong twice over:

- **It did not dissolve the slot-holding problem, it spread it.** `delegate_to_<agent>` blocks
  its turn for up to 60 seconds; generalising that would let any `async_run_command` block a
  turn for a minute. Moving the wait into the start call renamed the problem rather than
  removing it.
- **The inline fast path rested on an unevidenced assumption** — that most async work is fast.
  A caller that wanted a fast synchronous answer would not have reached for an async tool.
  Async means slow; optimising the short case is complexity for a case that barely exists.

Removing the wait entirely deletes the 60-second magic number rather than shrinking it, removes
budget tuning from the design, and leaves exactly one code path.

### Why the artifact store rather than a local file

Output must survive multi-host. The task row lives in shared Postgres, so a local file on the
host that ran the task would be unreadable from any other host serving `task_get` — a latent
bug the day the fleet runs multi-host, and this repo already builds a fleet image.

Reuse the artifact stores that already exist (`adapters/artifacts/` has S3-backed stores for
skills, toolchains and browser profiles). The task row carries an artifact reference, not a
filesystem path, so any host can serve the result and retention hooks into a solved shape.
This is also a different channel from the observability event, so no host path is ever
published to a webhook subscriber.

### What this removes

The 60-second magic number, the synchronous wait on every path, the inline fast path, budget
tuning, the generic-versus-curated delegation split, the duplicate DeepAgents `AgentDelegation`
facade, the polling obligation, and the `task_wait` tool proposed in the first draft.

### Sequencing, by damage

| Order | Change | Why this order |
|---|---|---|
| 1 | Artifact-store spill | data is destroyed today; nothing recovers it afterwards |
| 2 | Durable push on every terminal task, with coalescing | results exist but never arrive |
| 3 | One delegation pipeline with explicit target resolution | removes the weak path and the loop risk |
| 4 | Delete the duplicate facade | one start entry point per runtime |

### Explicitly NOT doing

- **No `SubagentStop`.** The native `Agent` path is disallowed; the hook would never fire.
- **No `task_wait` tool and no sync wait.** Cut during the grill.
- **No event streaming into the model.** Every pushed event costs a full inference turn.
  `task_get` already exposes a ~1s-refreshed stdout/stderr tail plus `lastProgress` and
  heartbeat for diagnosis, which is a poll-shaped need.
- **No Managed Agents migration.** Purpose-built for this shape, but beta and ineligible for
  ZDR and HIPAA BAA because session state persists server-side.
- **No new task table, queue or notification bus.** All three exist and work.

## Consequences

- **Coalescing is now the only cost control, which makes it load-bearing rather than a nicety.**
  With no inline path, EVERY async task costs a wake-up — including trivial ones. Completions
  landing while the parent is idle must batch into a single re-engagement, and the batching
  window is a first-class design parameter, not an implementation detail.
- **Self-delegation loop protection is required regardless of the test's provenance.** The
  owner reports the push-free behaviour was unfinished rather than deliberate, but generic
  delegation still defaults the child target to the caller's own agent, so enabling push makes
  looping reachable on its own merits. Target resolution must become explicit and same-agent
  delegation handled deliberately. The originating commit should still be spot-checked when
  implementing — "no remembered reason" is not the same as "no reason".
- The test asserting `sendMessage` is never called for generic delegation must be updated
  knowingly, with loop protection in place — not deleted to make a new assertion pass.
- Artifact-store spill inherits that subsystem's retention model rather than inventing one.
  Bound the POPULATION, not the rate: CANCEL-1's archive quarantine took six review cycles
  precisely because each attempt bounded work-per-call, entries-scanned, then removal-rate
  before landing on population. See [[audit-paydown-2026-07]].
- Scalability comes from convergence: every async kind and both runtimes end at the same
  completion contract and the same artifact-backed output. A new runtime inherits it.
- `async_mcp_call` nests its id under `task.id` while other starts return a top-level `id`.
  Worth normalising while this surface is open.

## Open questions for the grill

Resolved during the 2026-07-26 grill: the wait budget (removed — no sync wait), whether the
inline fast path earns its complexity (no — cut), why generic delegation was push-free
(unfinished, not deliberate), and where output lives (artifact store, fleet-safe).

Remaining:

1. **What is the coalescing window?** If two tasks finish ten minutes apart, is that one
   re-engagement or two? This is now the only control on wake cost.
2. What happens when completions land mid-turn — queue until the turn ends, or interrupt?
3. Does the parent receive batched results in completion order, and does order matter?
4. What wakes when the parent is gone — conversation ended, agent deleted? A follow-up must not
   create a spurious turn that talks to nobody. CANCEL-1 spent its existence on the mirror
   image of this.
5. Is there admission control if an agent fires many async tasks at once, or does the follow-up
   queue grow unbounded?
6. Should the child-target default (caller's own agent) change, or is self-delegation a
   supported case that simply needs loop protection?
7. Does the DeepAgents sentinel still earn its keep once the facade is deleted, given the tools
   it probes are never mounted?

See [[semantic-capabilities-are-the-feature]] and [[tool-surface-tiering]] — this contract must
not duplicate either.
