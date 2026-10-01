---
slug: one-permission-flow
title: Scheduled jobs and chat share one permission flow
status: draft
saved: 2026-10-01T12:01:54+00:00
---

# Scheduled jobs and chat share one permission flow

## Why

A scheduled job is the agent doing ordinary work while nobody is watching. It should interrupt a person only when it really needs to, in the conversation it belongs to, the same way a chat turn does. The agent should never bother anyone unless it has to. Today it bothers people too often, and jobs keep breaking.

**What the live data shows (last 30 days, 2026-10-01):**
- **People were asked 110 times and approved nearly every one,** and 80 of those asks repeated a program already approved in the same window. "Allow for future" was never chosen: 168 of 197 prompts only offered "Allow once / Cancel". A command with a pipe or `&&` could never be remembered. Of the 85 shell asks a person answered, only 3 were simple commands.
- **The classifier was overruled 69 times.** It said "allow", but a stricter check that runs before it turned that allow back into a question. That check stops any command whose shape it can't model, such as `cd … && ls`.
- **One job's read-only Google Sheets call was refused on 36 straight runs.** Its command template didn't match, and the capability was fixed as high risk.
- **49 asks and 29 job requests were left open with no end.**
- **One job's permission card grew to 10,169 revisions (2 MB).** It was reloaded every 5 seconds and froze the live runtime, so replies hung for minutes.

**What three audits of the code and its history found:**
- **Five ways to ask a person,** with seven different button sets.
- **One approval stored in up to seven places.**
- **Two run loops,** one for jobs and one for chat.
- **Each engine keeps its own copy of the permission checks.** The DeepAgents runner lets every Gantry tool through with no check. The inline lane cancels a scheduled run where the main path would ask.
- **Jobs keep their own lists of required tools,** separate from the agent's approvals.
- **About 100 of the 267 small fixes from July to September 2026 were about jobs, permissions or cards,** and what a job does at an unapproved tool changed six times in seven weeks.

## Behaviour

A job is an unattended agent turn in its own conversation. It uses exactly the same permission flow, prompt, run loop and reply path as a chat turn. The only difference is that nobody is watching while it runs.

**Ask only when needed**

- **One gate, on the host, for every tool call.** Every request goes through the same steps whether it comes from a chat turn or a job, on every engine (the Claude Agent SDK runner, the DeepAgents runner and the inline lanes), and including tools allowed privately today (Gantry tools on DeepAgents, inline core tools, `mcp_call_tool`, `capability_run`, browser actions). The steps run in this order:
  1. **Hard rules.** A hard rule decides alone, and it stops only real danger: destructive actions, secret or credential paths, privilege changes, uploading local files, and shapes that can never be approved permanently (download-then-run, such as `curl … | sh`, or running inline code through an interpreter). A command is never asked about just because of its shape: a pipe, a chain, a heredoc or a script the parser can't model goes on to the next steps instead.
  2. **Saved approvals.** A matching saved approval allows the call. Nothing after it runs.
  3. **The classifier.** It judges calls nothing saved covers, one program at a time. It is the independent judge on the host and can only allow or ask (decision 0043); the agent never judges its own permissions. When the classifier allows, nothing turns that back into a question. If its view of a call had to be cut short, it judges a summary naming the programs and paths; truncation alone never causes an ask. Its remembered verdicts are keyed by agent, conversation and program or capability, so the same kind of call isn't judged twice.
  4. **Ask a person.**

  The engines keep no allow or deny logic of their own. The only exceptions are checks only the runner can make, such as sandbox networking. A reviewed read capability, such as reading Google Sheets values, is judged like any other call and is not fixed as high risk. A command-template mismatch is shown to the owner once and never repeated as a denial on every run.
- **Who answers.** A prompt goes to the conversation the turn or job belongs to. People who may approve there are the conversation's existing approvers. If the conversation's route or binding is gone, the call is refused and the agent is told why; it never asks somewhere else.

**One prompt, three buttons**

- **Every prompt has the same buttons: Allow once / Allow for future / Deny.**
  - **Allow once** covers this call and later calls of the same capability or program for the rest of the current chat turn or job run.
  - **Allow for future** saves an approval (see below). It is offered on every prompt except an admin action or a hard-rule stop. For a shell command, the button names each program it will cover, for example "Always allow ls and wc in this chat".
  - **Deny** refuses this call. The agent is told and carries on without it; a denial is not remembered.
  - Batch "Allow all", the job card buttons, "Approve & run again" and the pause buttons are removed.
  - Owner choice, 2026-10-01: "Once / Future / Deny" everywhere.
- **The prompt says what and why in plain words.** It names the action by its friendly name ("Read Google Sheets values"), says which account, sheet, folder or command is involved (with secrets hidden), and gives the reason from the turn's own request. It never shows internal reasons. The details stay readable after a restart.
  - Before: "RunCommand `cd … && ls -la | wc -l` — Piped RunCommand commands cannot be authorized from per-leaf rules. [Allow once] [Cancel]"
  - After: "Main agent wants to count the files in proj (uses `ls`, `wc`), for the size report you asked for. [Allow once] [Always allow ls and wc in this chat] [Deny]"
- **One ask, one message.** Each ask creates exactly one waiting record and one message, whatever engine or tool name raised it. Answering updates that message in place; no separate "approved" or "resumed" message is sent.

**Saved approvals**

- **What one covers:** a named capability, such as `google.sheets.values.get`, or a program, such as `gh`, where no capability covers the call. For a tool with neither, it covers the tool itself, such as Web search. It never stores raw command text.
  - A program approval covers that program in any shell form: chains, pipes, heredocs and proxy prefixes. In a combined command, every program must be covered; approving `gh` doesn't approve the other program in `gh … && other …`. Anything the parser can't read goes to the classifier.
  - Owner choice, 2026-10-01: "program or capability". Why: command-text matching caused about 30 fixes and none of the 80 repeat asks was an exact repeat.
- **Where one applies:** to that agent in the conversation where it was given, for chat turns and jobs alike. In a group it covers everyone the agent works for there, and that group's jobs. It never reaches another conversation or another agent.
  - Owner choices, 2026-10-01: "this agent, this conversation" and "covers everyone in the group".
- **One store.** Saved approvals live in one place, and the list of them shows friendly names.
- **Old approvals carry over.** Each existing approval becomes an approval in the conversation where it was given: a person's direct-message approvals go to their direct chat with that agent, and a job's go to the job's conversation. None becomes wider than it is today.
  - Owner choice, 2026-10-01: "carry them over".
- **A saved approval that a stricter check later rejects** is replaced by the matching program approval where one is safe. The owner is told once, in that conversation. A bad entry never stops the runtime from starting.

**Admin actions always ask**

- Registering an agent, installing a skill, adding an MCP server, changing settings and restarting the service always ask, with the same prompt, in the conversation where the action was requested; for a job, that is the job's conversation.
- The classifier never approves them, and a saved approval never covers them. Their prompt offers Allow once and Deny only.
- Owner choice, 2026-10-01.

**A job is a turn in its conversation**

- **A job belongs to one conversation.** It reads and adds to that conversation's memory, and uses its approvals, just like a chat turn there. Approvals are read live: an approval given in the chat at any time, before or after the job was created, applies to the job's next call.
  - A job with no conversation today is attached to the conversation its results are delivered to. If it has none, it is paused with one notice to its owner.
  - Owner choice, 2026-10-01: "inherit what the chat conversation already had".
- **No declared tools and no setup pause.** Jobs no longer declare required tools. A blocker that isn't a permission (a missing credential, the credential broker being down) fails that run with one plain notice saying what to do.
- **A job waits like a chat turn.** When a job needs an answer, the run waits with the prompt in its conversation.
  - A recurring job waits until its next scheduled time. One-time and manually started jobs wait up to 24 hours.
  - If no answer comes by then, the run ends as "waiting for permission"; the next run asks again. Pausing, editing or deleting the job ends a waiting run the same way.
  - A late tap on an ended prompt says the request has ended and the job will ask again next time. The old prompt is closed before the next run starts, so a tap never approves a call twice.
  - Owner choices, 2026-10-01: "wait, then next run asks" and "24 hours" for one-off jobs.
- **A waiting job never blocks the conversation.** Chat in that conversation carries on while a job waits. One conversation runs one job at a time. A job run uses a fresh working session and doesn't change the chat's session.
- **Progress and result look like chat.** While a job runs, people see the same ambient progress a chat turn shows. There is no "Running…" card. The result is posted as a normal reply in the job's conversation and saved in its history.
  - Owner choices, 2026-10-01: "as a normal reply" and "same as chat".
- **One run loop.** A job runs through the same host runner as a chat turn, with one run record. The host creates the run's context once (job, conversation, account, approvers, run), and everything reads it.

**Quiet by default**

- No status notices in chat: no "Still working", capacity-delay, retry or "safety judge offline" messages. Delays and outages show in the ambient progress line and the logs, not as messages.
- A progress line that can't be updated is replaced quietly, never duplicated.

**Records stay bounded**

- Answered and ended prompts, finished run records, delivery rows and permission events are kept for 30 days, then removed in bounded batches.
- Waiting prompts, undelivered results and runs still in progress are never removed.
- A background check only reads rows that are still waiting, and in bounded pages.
- Nothing grows with every run.

**Decisions this changes**

- Replaced:
  - the living job card and job-only ask rules of 0144;
  - the setup-required pause and declared job tools of 0115, 0117, 0124 and 0127;
  - person-scoped approvals (0118) and the person-scoped job view (0153's projection).
- Also replaced: the planned CARDSIMPLE-2 and CARDSIMPLE-3 card work.
- Kept:
  - 0157 (jobs use the chat permission steps), completed here;
  - 0043 (the classifier only allows or asks);
  - 0053 (a waiting chat turn waits), which now covers jobs up to their deadline.

## Risks

- **One-way: old records are deleted.** Removing the job card, setup-pause records, job tool lists and the duplicate approval stores deletes data. Approvals are carried over first, and a carry-over that fails stops the migration rather than dropping approvals.
- **Approvals become broader in one way.** A program approval covers more forms of that program than an exact command did. Mitigations: the hard rules still stop danger, every program in a combined command must be covered, and approvals never leave their conversation.
- **Groups.** An approval given by one person in a group covers the agent's work for everyone there. Only the people the agent works for in that group can trigger it.

## Acceptance criteria

- AC1: For the same tool call, a chat turn and a scheduled job get the same decision from the same host gate on every engine. Tested with one table of calls through the Claude runner, the DeepAgents runner and the inline lane, for both a chat turn and a job, including Gantry tools, `capability_run` and browser actions.
- AC2: A shell command whose only issue is its shape (a pipe, a chain, a heredoc) reaches the classifier, and a classifier allow is never turned back into an ask. Hard-rule cases (destructive actions, secret paths, download-then-run) still stop.
- AC3: "Allow for future" is offered on every prompt except admin actions and hard-rule stops. After it is chosen for a shell command, the same programs in another shell form run without an ask in that conversation, for chat and jobs. A combined command with an uncovered program still asks. Another conversation or another agent still asks.
- AC4: A job whose conversation already approved a capability or program runs it without asking, including an approval added after the job was created. A job that needs a new approval shows the three-button prompt in its conversation and waits:
  - Allow once lets the run continue;
  - Allow for future also lets the next run continue;
  - no answer by the deadline (next scheduled time, or 24 hours for one-off jobs) ends the run as "waiting for permission", and the next run asks again;
  - a late or duplicate tap approves nothing twice.

  An end-to-end test through the real runtime and database covers this, including a worker restart while waiting.
- AC5: Prompts show the action's friendly name, the specifics with secrets hidden, and the reason. One ask produces one waiting record and one message.
- AC6: Admin actions always ask, offer only Allow once and Deny, and are never approved by the classifier or a saved approval.
- AC7: A job's result appears as a normal reply in its conversation's history. A missing credential fails the run with one notice. No setup-required pause, job card, "Running…" card or status notice is sent.
- AC8: Existing approvals carry over to their conversation without becoming wider, proven by a migration test on representative data. Paused setup-required jobs resume as normal jobs.
- AC9: A job that has run 1,000 times keeps a constant amount of permission and prompt state. A Postgres test ages records past 30 days and shows they are removed in bounded batches, while waiting prompts and undelivered results are kept.

## Success measure

- Metric: permission prompts shown to a person per week, and the share of them that repeat something already allowed in that conversation. Both are counted from the live database.
- Baseline: about 26 prompts a week (110 in the 30 days before 2026-10-01), with 73% repeats (80 of 110).
- Target: 8 or fewer prompts a week, and no repeats, in the first full month after the last story merges.
- Check date: 2026-12-15

## Roadmap

- PERMFLOW-1: One permission gate on the host that asks only when needed
- PERMFLOW-2: Saved approvals by capability or program, per conversation, in one store
- PERMFLOW-3: Jobs run as unattended turns on the chat prompt and run loop
- PERMFLOW-4: Remove the old job, card and setup machinery and keep records bounded
