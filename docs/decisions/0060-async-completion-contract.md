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

**One completion contract for every async kind: bounded sync wait, then durable push.**

The curated `delegate_to_<agent>` path already implements the correct shape — wait briefly,
return the result inline if it finishes, otherwise hand back a handle and durably wake the
parent when it completes. It is built, tested and works. Its only flaw is being wired for
callable agents alone. Promote it to THE contract for commands, MCP calls and all delegation,
on both runtimes.

1. Every async start accepts a **sync wait budget** (small default, configurable).
2. Work finishing inside that budget **returns inline** — no extra turn, no polling, no wake-up.
3. Work exceeding it returns a handle, and on terminal state emits **one durable follow-up**
   that re-engages the parent.
4. Output **always spills to a gantry-owned file** — bounded summary inline, path in the
   handle, full content via `task_get`. This is a separate channel from the observability
   event, so no host path is ever published to a webhook subscriber.
5. `task_get` / `task_list` / `task_cancel` / `task_message` remain for explicit inspection and
   live steering.

### Why this shape rather than the alternatives

- **Generalisation, not invention.** Universal push, better-polling, and a standalone wait tool
  are each a NEW mechanism. This is the existing one applied consistently.
- **The common case costs nothing.** Most async work is fast: it returns inline and never
  touches the push path. Slow work cannot lose its result. Neither case asks the agent to
  remember anything.
- **It removes a tool rather than adding one.** The bounded wait belongs in the start call, not
  in a separate `task_wait`. That also dissolves this design's most load-bearing open question
  — whether a wait primitive could park without holding a runner slot — because there is no
  wait primitive to park.
- **Scalability comes from the interface.** A new async kind implements one contract; a new
  runtime inherits it. That is what holds as the surface grows.

### What this removes

The 60-second magic number (becomes a configured budget), the generic-versus-curated
delegation split, the duplicate DeepAgents `AgentDelegation` facade, the polling obligation,
and the previously proposed `task_wait` tool.

### Sequencing, by damage

| Order | Change | Why this order |
|---|---|---|
| 1 | Gantry-owned spill file | data is destroyed today; nothing recovers it afterwards |
| 2 | One delegation pipeline with explicit target resolution | results exist but never arrive |
| 3 | Sync-wait budget on every async start | replaces the 60s hack; makes the fast path free |
| 4 | Delete the duplicate facade | one start entry point per runtime |

### Explicitly NOT doing

- **No `SubagentStop`.** The native `Agent` path is disallowed; the hook would never fire.
- **No `task_wait` tool.** Superseded by the sync-wait budget on the start call.
- **No event streaming into the model.** Every pushed event costs a full inference turn, so a
  chatty task would cost dozens. `task_get` already exposes a ~1s-refreshed stdout/stderr tail
  plus `lastProgress` and heartbeat for diagnosis, which is a poll-shaped need.
- **No Managed Agents migration.** Purpose-built for this shape, but beta and ineligible for
  ZDR and HIPAA BAA because session state persists server-side. A product decision, not a bug fix.
- **No new task table, queue or notification bus.** All three exist and work.

## Consequences

- Scalability comes from convergence rather than addition: every async kind — command, MCP
  call, delegated agent, both runtimes — ends at the same completion contract and the same
  file-backed output.
- **Wake amplification is a real cost and must be designed for, not discovered.** Ten
  background commands completing means ten follow-ups unless completions landing while the
  parent is idle are COALESCED into a single re-engagement. Treat coalescing as part of the
  contract.
- **Self-delegation loops become reachable.** Generic delegation currently defaults the child
  target to the caller's own agent. With push enabled that can loop, so target resolution must
  be explicit in one place and same-agent delegation handled deliberately rather than by default.
- Changing generic delegation's completion behaviour changes deliberate current behaviour
  pinned by a test asserting `sendMessage` is never called. That test must be updated knowingly,
  with the loop risk addressed — not deleted to make a new assertion pass.
- A spill file introduces retention obligations the in-memory buffer does not have: size caps,
  TTL, and cleanup on task deletion.
- `async_mcp_call` nests its id under `task.id` while other starts return a top-level `id`.
  Worth normalising while this surface is open; the model should not handle two shapes.

## Open questions for the grill

1. What is the right default sync-wait budget? Too short and everything takes the push path;
   too long and turns stall. It should be configurable per async kind.
2. How are concurrent completions coalesced into one re-engagement, and what is the batching
   window?
3. Why was generic delegation deliberately left push-free? The test is evidence of intent; the
   reasoning should be recovered before overriding it.
4. Where do spill files live, and under what retention? They contain arbitrary command output
   and inherit the same protection questions as any host-side artifact.
5. Should the child-target default (caller's own agent) change, or is self-delegation a
   legitimate supported case that simply needs loop protection?
6. Does the DeepAgents sentinel still earn its keep once the facade is deleted, given the tools
   it probes are never mounted?

See [[semantic-capabilities-are-the-feature]] and [[tool-surface-tiering]] — this contract must
not duplicate either.
