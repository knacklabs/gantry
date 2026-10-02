---
slug: subagents-end-to-end
title: Subagents work end to end
status: draft
saved: 2026-10-02T14:21:06+00:00
---

# Subagents work end to end

## Why

An agent should be able to hand part of a job to a subagent — wait for a quick answer, or start long work in the background and hear back — with the same permissions, limits and reporting as everything else in Gantry. Today it can't.

**What happened (2026-10-01):** asked "Can you invoke a subagent" three times in a Telegram group, the main agent refused each time: "No delegation or subagent executor is mounted in this run." Its own instructions said delegation was unavailable, though Gantry's host-side delegation exists. No delegated task has ever been recorded.

**What an audit of the delegation path found** ([research notes](../context/subagent-research-2026-10-02.md)):
- A Claude subagent answers and then hangs until its timeout, because its input stream never closes.
- Only the last streamed fragment of a subagent's answer is kept.
- A plain delegation never wakes the parent with the result, so the person never hears back.
- Which agents a subagent may run as is checked one way for worker runs, another for inline runs, and not at all after a restart. The person who asked isn't passed along, so a person-scoped grant fails.
- Steering an inline subagent reports success but never arrives; a subagent recovered after a restart can't be cancelled.
- A subagent started from a scheduled job loses the job's identity, can stop to ask people for permission, and never reports into the job's result.
- A requested time limit is lost after a restart; there are no turn or cost budgets.
- There is no way to wait for a quick answer, and no structured output.

**What the engines offer:** both engines have their own subagents (Claude Agent SDK 0.3.156 `agents`; deepagents 1.10.2 subagents, with structured output, file and store backends and remote async runs). Each brings its own lifecycle for permissions, cancellation, recovery and reporting, and they differ: Claude's subagents can't return structured output; deepagents' don't inherit our tools by default; deepagents' remote runs drop structured results; and our Claude SDK version doesn't forward permission prompts from background subagents.

## Behaviour

**One subagent mechanism, owned by Gantry.** Agents start subagents only through Gantry's delegation tool. The engines' own subagent tools stay off. Each engine gets a thin adapter that launches, streams, stops and resumes a child run and returns its output; everything else is shared.
- Owner choice, 2026-10-02: Gantry-owned delegation; engines' native subagents stay off.

**Two modes.**
- **Wait:** the parent waits inside its turn and gets the result. Cancelling the parent cancels its waiting subagents. A subagent that runs past its deadline fails clearly with a timeout result; it never quietly turns into background work. The parent decides what to do next.
  - Owner choice, 2026-10-02: "fail clearly".
- **Background:** the call returns at once. The subagent keeps running after the parent's turn ends, and when it finishes, the parent is woken in the same conversation and thread with the result and writes the reply. A result is delivered once, even across restarts.

**One result shape,** whatever the engine: a status (done, failed, timed out, cancelled), a short summary, optional structured output, optional files, an error and usage.
- **Structured output:** the parent can give an output schema. A result counts as done only if its output matches the schema; otherwise it fails with the reason.
- **Where results go:** small results are stored with the task; large ones go into files the task points to. Nothing is posted to the chat directly — the parent decides what to say. Memory changes only when an agent saves them explicitly.

**Control.**
- **Steering:** a message sent to a running subagent is acknowledged only when the subagent actually receives it, whichever runtime it runs in.
- **Cancellation** stops the subagent and anything it started, including after a restart.
- **Deadlines and budgets:** each subagent has a deadline, a turn limit and a cost limit. The remaining time survives a restart. A parent has a cap on how many subagents run at once.

**Authority.**
- A subagent runs with the person, conversation, thread and account of the turn that started it.
- A subagent running as the same agent inherits that agent's permissions. Delegating to another named agent needs that delegation to be allowed, and the subagent then has the other agent's permissions.
- Authority is checked again before a recovered subagent runs.
- One level only: a subagent can't start subagents.
- An agent needs delegation enabled to use it. When it isn't, the agent says so plainly and names how the owner enables it.

**Jobs.** A subagent started from a scheduled job runs as part of that job: it keeps the job's identity and remaining deadline, follows the job's permission rules, and its result is part of the job's result. It never outlives the job.

**What people see.** Subagent status shows on the turn's one progress card: queued, running, waiting for permission, done or failed, with a short summary. A subagent's own text is not streamed into the chat.

**Decisions this changes:** none recorded; the stale instruction that delegation is unavailable is removed.

## Risks

- **More agent work runs at once.** Background subagents use model capacity and cost. Mitigation: per-subagent turn and cost limits and the per-parent cap.
- **A recovered subagent may repeat side effects.** Where an engine can't resume, an interrupted subagent is reported as interrupted rather than run again.
- **Changed tool contract.** The delegation tool gains a mode and an output schema; agents' guidance is updated in the same change. No data is deleted.

## Acceptance criteria

- **AC1. Wait mode.** A parent waits for a subagent and gets its full answer in the same turn, on the Claude and deepagents engines, worker and inline; past its deadline it gets a timeout result.
- **AC2. Background mode.** A background subagent's result wakes the parent in the same conversation and thread, once, including across a restart.
- **AC3. Structured output.** With an output schema, a matching result is done and a non-matching one fails with the reason, on both engines.
- **AC4. Steering and cancellation.** Steering is acknowledged only on receipt; cancellation stops a subagent and its work, including one recovered after a restart.
- **AC5. Authority.** The same delegation decision applies in worker, inline and recovered runs; a person-scoped grant works; delegating to a named agent without permission is refused; a subagent can't start a subagent.
- **AC6. Jobs.** A job's subagent keeps the job's identity and deadline, never asks a person outside the job's rules, and its result is in the job's result.
- **AC7. Visibility.** The progress card shows each subagent's state; no subagent text streams into the chat.
- **AC8. Honest refusal.** With delegation not enabled, the agent says so and names how to enable it.

## Success measure

- Metric: share of delegated tasks that end done (not hung, lost or timed out by the system) in the live database, per week.
- Baseline: 0 — no delegated task has ever completed (no rows in the delegated or async task tables as of 2026-10-02).
- Target: 95% or more of delegated tasks end done or fail with a clear reason, in the first full month after the last story merges.
- Check date: 2027-03-01

## Roadmap

- SUB-1: A subagent's answer reaches the parent, waiting or in the background
- SUB-2: Subagents follow the same authority, job and budget rules as their parent
- SUB-3: Subagents can be steered, cancelled and recovered, and show on the progress card
