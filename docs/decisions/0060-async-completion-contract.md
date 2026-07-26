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

Converge on one async completion contract. Reuse what already works — the durable follow-up,
the task table, the curated pipeline — rather than adding a parallel system.

**1. Gantry owns a spill file.** Write the full stdout/stderr and MCP result to a
gantry-controlled file, record the path on the task row, return it through `task_get` and in
the start handle. This is a different channel from the observability event, so no host path is
ever published to a webhook subscriber.

**2. Converge the two delegation products into one pipeline with different defaults.** Target
resolution and follow-up arming should be decided in one place. Do NOT simply arm completion
follow-up on the generic path: because it defaults the child to the caller's own agent,
universal waking invites self-delegation loops, and the existing test asserting no push is
evidence someone already considered this.

**3. Add `task_wait(taskId, timeoutMs)` that does not hold a runner slot.** Bounded, parking
without a lease, falling back to the durable follow-up when the bound expires. This replaces
the curated path's 60-second magic number rather than relocating it.

**4. Delete the duplicate `AgentDelegation` facade** so there is one start entry point.

### Sequencing, by damage

| Order | Change | Why |
|---|---|---|
| 1 | Output spill | data is destroyed; nothing can recover it afterwards |
| 2 | Delegation convergence | results exist but never arrive |
| 3 | `task_wait` | ergonomics; removes a hack |
| 4 | Facade removal | tidy-up |

### Explicitly NOT doing

- **No `SubagentStop`.** The native `Agent` path is disallowed; the hook would never fire.
- **No event streaming into the model.** Every pushed event costs a full inference turn, so a
  chatty task would cost dozens. `task_get` already exposes a ~1s-refreshed stdout/stderr tail
  plus `lastProgress` and heartbeat for diagnosis, which is a poll-shaped need. Waiting is
  worth building; streaming is not.
- **No Managed Agents migration.** It is Anthropic's purpose-built durable-async product and
  does solve this shape, but it is beta and ineligible for ZDR and HIPAA BAA because session
  state persists server-side. That is a product-level decision, not a bug fix.
- **No new task table, queue or notification bus.** All three exist and work.

## Consequences

- Scalability comes from convergence rather than addition: every async kind — command, MCP
  call, delegated agent, both runtimes — ends at the same completion contract and the same
  file-backed output. A future runtime implements one small adapter instead of a parallel stack.
- Changing generic delegation's completion behaviour changes deliberate current behaviour
  pinned by a test. That test must be updated knowingly, with the self-delegation loop risk
  addressed, not deleted to make a new assertion pass.
- A spill file introduces retention and cleanup obligations that the current in-memory buffer
  does not have — size caps, TTL, and cleanup on task deletion all need answering.
- `async_mcp_call` nests its id under `task.id` while the other starts return a top-level `id`.
  Worth normalising while touching this surface; the model should not have to handle two shapes.

## Open questions for the grill

1. **Can `task_wait` park without holding a runner slot or live-admission capacity?** If not,
   change 3 needs a different shape — a blocking wait that consumes interactive capacity does
   not scale, which defeats the point.
2. Why was generic delegation deliberately left push-free? The test is evidence of intent; the
   reasoning should be recovered before overriding it.
3. Where should spill files live, and under what retention? They contain arbitrary command
   output, so they inherit the same protection questions as any host-side artifact.
4. Should the child-target default (caller's own agent) change, or is self-delegation a
   legitimate supported case?
5. Does the DeepAgents sentinel still earn its keep once the facade is deleted, given the tools
   it probes are never mounted?

See [[semantic-capabilities-are-the-feature]] and [[tool-surface-tiering]] — this contract must
not duplicate either.
