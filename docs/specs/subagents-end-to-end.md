---
slug: subagents-end-to-end
title: Subagents work end to end
status: confirmed
saved: 2026-10-02T14:21:06+00:00
confirmed_by: "Ravi"
confirmed_hash: 9bc47c819e5dda6dabc5febd485280b739ecec56f59346aa8659633b47f81adf
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

**One subagent mechanism, owned by Gantry.** Agents start subagents only through Gantry's delegation tool. The engines' own subagent tools stay off. Each engine gets a thin adapter that launches, streams and stops a child run and returns its output; everything else is shared. Interrupted runs are not resumed or automatically run again.
- Owner choice, 2026-10-02: Gantry-owned delegation; engines' native subagents stay off.

**Two modes.**
- **Choosing a mode.** The agent uses wait mode only for quick answers; anything longer starts in background mode. Each wait lasts 5 minutes by default; the parent may request a shorter wait. Waiting again starts another wait, but never extends the subagent's own deadline or budgets.
- **Wait:** the parent waits inside its turn and gets the result. Cancelling the parent cancels its waiting subagents.
  - **At the wait deadline the subagent isn't killed.** The parent gets "not finished yet" with the progress so far and the task id, and explicitly chooses within its turn: wait longer, move it to the background (it then reports back like any background subagent), or cancel it.
  - **If the parent chooses nothing,** the subagent is cancelled when the parent's turn ends. It never quietly turns into background work.
  - Owner choice, 2026-10-02: "fail clearly"; refined by the owner's delegation ("you check and take the action") so that a timeout keeps the work and the parent decides.
- **Background:** the call returns at once. Outside scheduled jobs, the subagent keeps running after the parent's turn ends, and when it finishes, the parent is woken in the same conversation and thread with the result and writes the reply. A result is delivered once, even across restarts. Scheduled jobs follow the settlement rule under Jobs below.
  - **At its own deadline or budget,** a background subagent is stopped and the parent is woken with "timed out", what was finished and any partial result, so it can tell the person or restart it with a bigger budget.

**One result shape,** whatever the engine: a status (done, failed, timed out, cancelled), a short summary, the complete answer as text or a file reference, optional structured output, optional files, an error and usage. Failed, timed-out and cancelled results keep any partial answer and name the reason.
- **Full answers:** the complete final answer is assembled from the child's streamed output and saved before the task is marked done. Answers up to 4,000 characters are returned as text; longer answers are saved in a file, and the parent gets a summary and a reference to the complete answer in the same turn. `task_get` returns the saved answer or its file reference and lets the parent retrieve a large answer in parts of up to 4,000 characters, each with the position of the next part until the end. These reads use the task's authority and do not require a separate file permission. A summary or preview never replaces the saved answer.
- **Structured output:** the parent can give an output schema. A result counts as done only if its output matches the schema; otherwise it fails with the reason.
- **Where results go:** small results are stored with the task; large ones go into files the task points to. Nothing is posted to the chat directly — the parent decides what to say. Memory changes only when an agent saves them explicitly.

**Control.**
- **Steering:** a message sent to a running subagent is acknowledged with "Message received" only when the subagent actually receives it, whichever runtime it runs in. Waiting for a receipt ends after 30 seconds, or sooner if the caller is cancelled, the child finishes or the runtime becomes unreachable. Before delivery, queued or terminal tasks return "Message not delivered: subagent is not running"; a known delivery failure returns "Message not delivered" with the reason. If delivery was attempted but no receipt arrived, return "Message receipt not confirmed" with the reason, never success. No automatic resend; a late receipt is saved with the task but does not change the returned outcome.
- **Cancellation** stops the subagent and anything it started, including after a restart.
- **Deadlines and budgets:** defaults and ceilings are 30 minutes from admission, 50 model turns and US$5 of model cost per subagent. The parent may request smaller positive limits for a new task; limits cannot be raised after admission. A new attempt may have larger limits than a previous attempt, within these ceilings. Raising a ceiling requires an owner-approved change. Any lower limit already imposed by the agent or job still applies.
  - A model turn is one request to the model, including retries and requests after tool results or steering; tool calls and streamed fragments are not extra turns. No model request starts after the turn allowance is used up.
  - Model cost is cumulative across requests. Check it after each response and before starting another request; one in-flight request may take the total over the limit, and that overrun is recorded. If reliable cost accounting is unavailable, fail before starting; if it becomes unavailable during work, stop as failed with "Cost limit cannot be enforced" and retain the partial answer. Unknown cost is never counted as zero.
  - The deadline is an absolute time saved at admission. Queue time, permission waits and downtime all consume it. Save the limits, used turns and reported cost with the task; recovery never resets them. At a deadline or turn or cost limit, stop the child and its linked work, record "timed out" with the specific exhausted limit and partial answer, and return it to a waiting parent or wake a background parent.
  - At most three admitted, unfinished subagents belong to the same parent agent in the same app, conversation, thread and account, across parent turns and restarts. Queued children and children waiting for permission count toward the cap. An additional request is refused with "Subagent limit reached; wait for or cancel an existing subagent"; it does not create a task. Admitted tasks may still queue for shared model capacity.

**Restart.** Completed results remain available and pending background results are delivered once. Only queued background work that never started may start after recovery, after authority and the saved limits are checked again; expired work becomes timed out without starting. If a queued wait-mode task loses its parent turn, cancel it with "Parent turn interrupted". Any child that had started but has no surviving host controller is stopped with its linked work and recorded as failed with "Interrupted by restart" and its partial answer; it is never replayed, on either engine or runtime. A saved cancellation or expired deadline is settled as cancelled or timed out instead. For an interrupted wait-mode parent, save the outcome for `task_get` and wake the parent in the same conversation and thread once to report it; do not revive the interrupted tool call. Restart does not silently convert the child to background work.

**Authority.**
- A subagent runs with the person, conversation, thread and account of the turn that started it.
- A subagent running as the same agent inherits that agent's permissions. Delegating to another named agent needs that delegation to be allowed, and the subagent then has the other agent's permissions.
- Authority is checked again before a recovered subagent runs.
- One level only: a subagent can't start subagents.
- An agent needs delegation enabled to use it. When it isn't, the agent says so plainly and names how the owner enables it.

**Jobs.** A subagent started from a scheduled job runs as part of that job: it keeps the job's identity and remaining deadline, follows the job's permission rules, and its result is part of the job's result. It never outlives the job. Background mode lets the job's parent continue working, but does not extend the job run: when the parent finishes, stop unfinished children and their linked work as cancelled with "Job finished before subagent", then record every child's outcome, partial answer and result references in the job result before settling the job. Do not wait for children to finish naturally; any failed, timed-out or cancelled child makes the job result failed. At the job deadline, stop unfinished children as timed out with "Job deadline reached". On lease loss, stop them as cancelled with "Job lease lost"; only the current lease owner may settle the job and include their recorded outcomes. Job children never wake an interactive parent or produce a separate chat reply, including after recovery.

**What people see.** Subagent status shows on the current parent turn's one progress card: queued, running, waiting for permission, done, failed, timed out or cancelled, with a short summary and a reason for unsuccessful outcomes. The card includes this turn's children, unfinished children from earlier turns and results delivered in this turn, all for the same parent agent, app, conversation, thread and account. When a turn ends, its card stops updating and unfinished background children are labelled "Continuing in background". Later updates belong to the next active parent turn's card, refreshed from saved task state, including after a restart; no idle card is kept alive. Outside scheduled jobs, completion wakes the parent to handle the result once, using its existing active turn or starting a new one and its progress card. A subagent's own text is not streamed into the chat.

**Decisions this changes:** none recorded; the stale instruction that delegation is unavailable is removed.

## Risks

- **More agent work runs at once.** Background subagents use model capacity and cost. Mitigation: per-subagent turn and cost limits and the per-parent cap.
- **A restart can interrupt useful work.** Recover only background tasks that never started; stop and report interrupted running children rather than repeat uncertain side effects.
- **Changed tool contract.** The delegation tool gains a mode and an output schema; agents' guidance is updated in the same change. No data is deleted.

## Acceptance criteria

- **AC1. Wait mode.** A parent waits for a subagent and receives the complete answer up to 4,000 characters, or a summary and a reference to the complete saved answer for a longer result, in the same turn, on the Claude and deepagents engines, worker and inline. A multi-fragment answer is preserved in full; scoped `task_get` reads of up to 4,000 characters retrieve every part through the end without a separate file permission. After a wait of 5 minutes by default, or a shorter requested wait, the parent gets "not finished yet" with progress and can wait longer, move it to the background or cancel it; no wait extends the child's limits. If it does nothing, the subagent is cancelled at the end of the turn.
- **AC2. Background mode.** Outside scheduled jobs, a background subagent's result wakes the parent in the same conversation and thread, once, including across a restart; one that hits its deadline or budget is stopped and the parent is woken with "timed out" and the partial result. Job children follow AC6.
- **AC3. Structured output.** With an output schema, a matching result is done and a non-matching one fails with the reason, on both engines.
- **AC4. Steering and cancellation.** Both runtimes return "Message received" only on child receipt, and stop waiting within 30 seconds or sooner on caller cancellation, child completion or an unreachable runtime. Queued and terminal children reject steering; known non-delivery and unconfirmed receipt return the Behaviour outcomes without automatic resend or false success, including when the child finishes or is cancelled during delivery. Cancellation stops a subagent and its linked work, including a queued background child started after recovery.
- **AC5. Authority.** The same delegation decision applies in worker, inline and recovered runs; a person-scoped grant works; delegating to a named agent without permission is refused; a subagent can't start a subagent.
- **AC6. Jobs.** A job's subagent keeps the job's identity and deadline and never asks a person outside the job's rules. When the parent finishes, unfinished children and linked work are cancelled before job settlement; each child's outcome and any partial answer or result references are included, and unsuccessful children make the job result failed. Job deadline expiry and lease loss stop children with the specified statuses and reasons; only the current lease owner settles the job. Children never outlive the job run or cause an interactive follow-up, including after recovery.
- **AC7. Visibility.** The current parent turn's card shows the scoped children's seven states and summaries, including timed-out and cancelled reasons. The originating card stops updating at turn end and marks unfinished background work "Continuing in background". Another active turn, a completion turn or the first turn after restart refreshes its own card from saved state; child updates never revive a retired card. No subagent text streams into the chat.
- **AC8. Honest refusal.** With delegation not enabled, the agent says so and names how to enable it.
- **AC9. Limits.** Both engines and runtimes apply the 30-minute, 50-turn and US$5 defaults and ceilings, smaller requested limits and any lower agent or job limits. Turn counting includes retries; exhausted limits stop the child and linked work with the named reason and partial answer. Cost overruns from one in-flight request are recorded, no further request starts, and unavailable cost accounting fails clearly. Queue time, permission waits and downtime consume the absolute deadline. A fourth unfinished child in the same parent scope is refused without admission, including across parent turns or recovery. Saved limits and usage never reset.
- **AC10. Restart.** A never-started queued background child starts only after rechecking authority and saved limits; expired children never start. A queued wait child whose parent turn was lost is cancelled. Interrupted running children and linked work are stopped and reported failed without replay on both engines and runtimes, except saved cancellations or expired deadlines retain their respective terminal statuses. An interrupted waiting parent receives one outcome follow-up and can retrieve its saved partial answer; completed and pending background results are preserved and delivered once.

## Success measure

- Metric: share of each UTC calendar week's admitted delegated tasks that have a saved terminal outcome by their own deadline plus one minute. Count done with a complete saved answer, or failed, timed out or cancelled with a clear reason and any available partial answer. Include deliberate deadline expiry and cancellations in both numerator and denominator; overdue unfinished, hung or lost tasks stay in the denominator and fail the measure. Refused requests are not admitted and are excluded. Check the cohort one minute after its latest deadline.
- Baseline: 0 — no delegated task has ever completed (no rows in the delegated or async task tables as of 2026-10-02).
- Target: 95% or more meet this same terminal-outcome measure in each weekly cohort admitted during the first full month after the last story merges.
- Check date: 2027-03-01

## Roadmap

- SUB-1: A subagent's answer reaches the parent, waiting or in the background
- SUB-2: Subagents follow the same authority, job and budget rules as their parent
- SUB-3: Subagents can be steered, cancelled and recovered, and show on the progress card
