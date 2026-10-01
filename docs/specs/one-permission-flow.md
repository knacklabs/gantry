---
slug: one-permission-flow
title: Scheduled jobs and chat share one permission flow
status: draft
saved: 2026-10-01T11:49:07+00:00
---

# Scheduled jobs and chat share one permission flow

## Why

A scheduled job is meant to be the agent doing ordinary work while nobody is watching. It should ask for permission only when it really needs to, in the conversation it belongs to, the same way a chat turn does. Today it doesn't, and jobs break again and again.

What three audits of the code and its history found (2026-10-01):

- **Five separate ways to ask the user:** the chat prompt, a job's long-lived permission card, a "setup required" card, pause buttons, and an amendment card. They use seven different button sets.
- **One approval is stored in up to seven places,** so five background repair loops run every few seconds just to keep those copies in step.
- **Jobs run on their own host loop,** separate from chat. They have their own failover, two run records per run, and a different result path.
- **Every agent engine keeps its own copy of the permission checks.** The copies disagree. For example, the inline lane cancels a scheduled run where the others would ask.
- **Jobs keep their own lists of required tools** and pause before running when the lists don't match what the agent is actually allowed to do.
- **Saved approvals match the exact command text.** Every new shell construct (proxy prefixes, `&&`, pipes, heredocs, `find` options) became a new "approved but denied" bug.

**Cost:**
- About 100 of the 267 small fixes between July and September 2026 were about jobs, permissions or cards.
- What a job does when it meets an unapproved tool changed six times in seven weeks.
- On 2026-10-01 one job's permission card had grown to 10,169 revisions (2 MB). It was reloaded every 5 seconds and froze the live runtime: replies hung for minutes.
- About 60,000 lines serve what is, in practice, a few scheduled jobs.

## Behaviour

A job is an unattended agent turn in its own conversation. It uses exactly the same permission flow, prompt, run loop and reply path as a chat turn. The only difference is that nobody is watching while it runs.

- **One gate, on the host, for every tool call.** Every request goes through the same steps, in this order, whether it comes from a chat turn or a job, and on every engine (the Claude Agent SDK runner, the DeepAgents runner and the inline lanes):
  1. hard rules;
  2. remembered approvals;
  3. the classifier;
  4. ask the user.

  The engines send every tool call to this gate and keep no allow or deny logic of their own. The only exceptions are checks that only the runner can make, such as sandbox networking. Tools that are allowed privately today (`mcp_call_tool`, `capability_run`, browser actions) go through the gate too. The classifier stays an independent judge on the host that can only allow or ask (decision 0043). The agent never judges its own permissions.
- **One prompt, with three buttons, everywhere:** Allow once / Allow for future / Deny. A job's prompt is the same chat prompt, posted in the job's conversation. Allow once covers the current chat turn, or the current job run. Batch "Allow all", the job card's buttons, "Approve & run again" and the pause buttons are removed.
  - Owner choice, 2026-10-01: "Once / Future / Deny" everywhere. Why: one vocabulary, and a job may need a one-off approval too.
- **A job waits like a chat turn.**
  - When a job needs an answer, the run waits with the prompt in its conversation.
  - If nobody answers by the job's next scheduled time, that run ends as "waiting for permission" and the next run asks again.
  - There is no hand-off card and no "approve and run again" step. A chat prompt never stops being answerable while its turn is still waiting.
  - Owner choice, 2026-10-01: "Wait, then next run asks". Why: chat behaviour, with no extra machinery.
- **A job belongs to its conversation and inherits it.**
  - A job is tied to one conversation. It uses that conversation's memory and approvals, just like a chat turn there.
  - Approvals are read live, not copied into the job. An approval given in the chat at any time, before or after the job was created, applies to the job's next call. So it is never asked again just because it is scheduled.
  - Jobs no longer declare required tools, and there is no "setup required" pause.
  - A blocker that isn't a permission, such as a missing credential or the credential broker being down, fails that run with one plain notice that says what to do.
  - Owner choice, 2026-10-01: "inherit what the chat conversation already had". Why: no special asks for scheduled jobs.
- **"Allow for future" covers a program or a named capability, for this agent in this conversation.**
  - A saved approval names a capability, such as `google.sheets.values.get`, or, where no capability covers the call, a program such as `gh` or `psql`. It never names raw command text.
  - Prompts and the list of saved approvals show the capability's friendly name, such as "Read Google Sheets values", not the command behind it.
  - The hard rules and the classifier still check every call.
  - It applies to that agent in the conversation where it was given, for chat turns and jobs alike.
  - There is one store for approvals.
  - A saved approval that fails a stricter check later is skipped with a warning, and never stops the runtime from starting.
  - Owner choices, 2026-10-01: "program or capability" and "this agent, this conversation". Why: command-text matching caused about 30 fixes, and an approval given in a DM shouldn't open a team group.
- **Admin actions always ask the user, in the same way.** Registering an agent, installing a skill, adding an MCP server, changing settings and restarting the service use the same prompt, in the conversation where the action was asked for. A job's admin asks come up in the job's conversation. The classifier never approves them by itself, and "Allow for future" is not offered.
  - Owner choice, 2026-10-01.
- **A job's progress and result look like chat.**
  - While a job runs, the user sees the same ambient progress a chat turn shows. There is no separate "Running…" card.
  - The result is posted as a normal reply in the job's conversation and saved in its history, so people can reply to it and the agent can refer back to it.
  - Each run starts with a fresh working session.
  - Owner choices, 2026-10-01: "as a normal reply" and "same as chat".
- **One run loop.** A job runs through the same host runner as a chat turn. Each run gets one run record, and the host creates the run's context once (job, conversation, account, approver, run). Everything reads that context, rather than rebuilding it from chat ids and route keys.
- **Records stay bounded.** Answered prompts, finished run records, delivery rows and permission events are kept for a set time and then removed. No record grows with every run.
- **Replaced decisions.** This replaces the living job card and the job-only ask rules of 0144, and the setup-required pause and declared job tools of 0115, 0117, 0124 and 0127. The planned CARDSIMPLE-2 and CARDSIMPLE-3 card work is replaced too. Decision 0157 (jobs use the chat permission steps) stays and is completed here. Decision 0053 (a waiting chat turn waits) stays, and now covers jobs until their next scheduled time.

## Acceptance criteria

- AC1: For the same tool call, a chat turn and a scheduled job get the same decision from the same host gate on every engine. Tested by running one table of calls through the Claude runner, the DeepAgents runner and the inline lane, for both a chat turn and a job.
- AC2: A job whose conversation already approved a tool for its agent runs that tool without asking. A job that needs a new approval posts the normal three-button prompt in its conversation and waits:
  - Allow once lets the run continue;
  - Allow for future also lets the next run continue without asking;
  - no answer before the next scheduled time ends the run as "waiting for permission", and the next run asks again.

  An end-to-end test covers this.
- AC3: An approval added in the chat after a job was created applies to that job's next run without another ask. Prompts show capability names, not commands. An approval given for a program covers that program's commands whatever shell form they take: `&&`, pipes, heredocs, proxy prefixes. The hard rules still block a dangerous call. An approval given in one conversation does not apply in another.
- AC4: Admin actions always ask, and never offer "Allow for future".
- AC5: A job's result appears as a normal reply in its conversation's history. A missing credential fails the run with one notice. No "setup required" pause, job card or "Running…" card exists any more.
- AC6: No permission, prompt, card or run record grows with every run. A job that has run 1,000 times keeps a constant amount of permission state, and a background loop never reloads more than the rows that are still waiting.

## Success measure

- Metric: fixes per month to jobs, permissions, prompts and cards, counted from merged pull requests and quick fixes.
- Baseline: about 33 a month (about 100 between July and September 2026).
- Target: 5 or fewer a month in the first full month after the last story merges.
- Check date: 2026-12-15

## Roadmap

- PERMFLOW-1: One permission gate on the host for every engine and lane
- PERMFLOW-2: Jobs run as unattended turns on the chat prompt and run loop
- PERMFLOW-3: Remove the old job, card and setup machinery and bound what's left
