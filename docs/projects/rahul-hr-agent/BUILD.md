# What We're Building

**Status:** Active · **Date:** 2026-04-17 · **Read first** — the one-page scope. Deep reference is [ARCHITECTURE.md](ARCHITECTURE.md) and [../../plans/agent-platform.md](../../plans/agent-platform.md).

## TL;DR

A platform in MyClaw where an admin configures a virtual employee's behavior **by typing plain English in a Slack channel** — no code, no deploys. Rahul is the first deployment (HR junior reporting to Pramod). The platform is designed so the next virtual teammate (recruiter, finance, ops) is 30 minutes of YAML + a provisioning run, not a new project.

## Why this exists

### The problem
Pramod (HR lead) spends 2–3 hours a day on manual ops: pinging 47 people for attendance, chasing non-responders, updating a sheet, nudging people about appraisal forms, writing daily summaries. Repeats forever.

### The trap we're avoiding
The obvious thing to build is "Rahul the attendance bot." A weekend script: cron + Slack SDK + Google Sheets. **It works for attendance and dies on everything else.** Every new HR behavior becomes a new project.

### The leverage
If we build the platform properly:
- Day 2, Pramod wants appraisal reminders → he types it in the admin channel, approves, it runs. 10 minutes.
- Month 3, CEO wants Priya the recruiter → new folder, new photo, new admin channel, new instructions. 30 minutes.
- The 2nd, 3rd, 10th virtual teammate is **almost free**.

That's the CEO's real ask. "Don't design this only for attendance."

## What success looks like — example use case

**Monday morning, 9am.** Pramod types in `#hr-rahul`:

> "Every weekday 10am, DM everyone asking office/WFH/leave. If working, also ask project and allocation %. Log to the Attendance 2026 sheet. Send me a noon summary."

Rahul responds: *"Got it — first run today at 10am, 47 people from the Employees sheet, logging to Attendance 2026, noon digest. Confirm?"*

Pramod taps **Approve**.

**10:00am.** Rahul DMs each of 47 employees: *"Morning! Office, WFH, or leave today?"* The conversations are "parked" — Rahul doesn't block waiting.

**10:17am.** Priya replies: *"wfh, billing, 80%"*. Rahul parses, writes the row to the Sheet, marks her done.

**Throughout the morning.** As each person replies, their row gets logged. 3 people don't reply by noon — they get flagged.

**12:00pm.** Rahul posts in `#hr-rahul`: *"Attendance Apr 20: 42/47 replied, 3 pending, 2 on leave. [thread]"*.

**Day 2 — same path, new behavior.** Pramod types: *"Remind anyone who hasn't filled the April self-appraisal."* Confirmation button. Approved. Rahul reads the Forms responses via CLI, diffs against the roster Sheet, DMs the gap, reports back. **Zero code changes.**

That second instruction is the proof that the architecture is right.

## What we're building (4 pieces)

### 1. Workflow recipes (the brain for long-running work)

When Pramod types an instruction in English, a small AI subagent translates it **once** into a structured JSON recipe and saves it to SQLite. The recipe captures: name, schedule, audience, steps, outputs.

**Why:** English is fuzzy. "Everyone" means different things. Translating once into a recipe gives us a machine-readable plan that cron can replay forever, and that Pramod can later edit/pause/delete via chat.

### 2. An engine that runs recipes step-by-step

A step executor that wakes up on cron, loads a recipe, and walks through its steps. When a step waits for a human reply ("ask Priya and collect her answer"), the engine **parks** that step in the database and moves on. When the reply arrives, the engine resumes at the parked step.

**Why:** LLMs forget between calls. Slack replies arrive hours after the question. Servers restart. Without durable state outside the LLM, this all falls apart. The database is the agent's long-term memory; the LLM is a stateless brain we can reboot any time.

### 3. Capabilities = CLIs on the VM

Rahul's "Google Sheets access," "Gmail access," "Calendar access" are **not code we write**. They're CLIs installed on the VM: `gworkspace`, `slack-cli`, `gh`, etc. OneCLI wraps credential injection (`onecli exec -- gworkspace sheets append ...`). Claude composes the right command via the Bash tool he already has.

**Why:** Vendors ship CLIs. We don't need to own glue code for every system Rahul might need. Adding Jira next quarter = install `jira-cli`, add to capability manifest, done. Zero MyClaw change.

### 4. Safety hooks (this is load-bearing)

Because Bash is powerful, we need a `PreToolUse` hook that inspects every shell command Rahul tries to run:
- Rate-limit outbound actions (DMs/hour, Gmail sends/day)
- Block dangerous patterns (`rm -rf`, raw network tools, unwrapped credentials)
- Enforce admin-channel-only for behavior-changing commands
- Log every command for audit

**Why:** With typed API wrappers, rate limits are free. With Bash, Claude could write `for user in ...; do slack dm ...; done` and blast 10,000 DMs in seconds. The hook is our firewall.

## What we're not building (clarity through negation)

- **Custom Google Sheets / Gmail / Forms integration code.** CLIs on the VM replace all of it.
- **A new framework** (LangGraph, Temporal, Inngest, CrewAI). Claude Agent SDK + SQLite + scheduler is enough for v1.
- **A custom DSL or YAML for workflows.** Zod schema + structured LLM output is the contract.
- **A web UI for approvals.** Mini App is already removed. Channel-native Slack Block Kit buttons handle it.
- **A multi-agent debate system.** One agent per teammate. Subagents only for context isolation (e.g., the intake parser).
- **A separate employees database.** Roster = a Google Sheet, read via CLI. Can add a DB table later if it becomes painful.

## Build order (4 PRs)

### PR 1 — Workflow schema + store
Add Zod schema, SQLite migrations for `workflows`, `workflow_runs`, `conversation_state`, `audit_log`. No behavior change.
**Done when:** unit tests round-trip a recipe through SQLite; passes architecture fitness checks.

### PR 2 — Engine + conversation checkpointing
Step executor. `ask_and_collect` parks a step in `conversation_state`; inbound message resumes it. Scheduler gains `suspendRun()` / `resumeRun()`.
**Done when:** a fixture workflow runs end-to-end, parks on a question, resumes on a reply, logs the result. VM restart mid-flight doesn't break it.

### PR 3 — Intake subagent + admin channel gate + Bash safety hook
NL → WorkflowSpec subagent. Admin-channel allowlist in `settings.yaml`. `PreToolUse` hook with rate limits, dangerous-pattern blocks, `onecli exec` enforcement.
**Done when:** admin types an instruction in `#hr-rahul`, confirmation echo fires, workflow lands in DB, scheduler arms. A recipe that tries to loop-DM 1000 people gets throttled by the hook.

### PR 4 — Persona + capability manifest + audit + polish
Per-agent `config.yaml` and `capabilities.md` loader. Persona module (photo, title, intro post). Audit hook writes every Bash invocation to `audit_log`. Kill switch `@rahul stop`.
**Done when:** Rahul appears as a person in Slack with photo and intro. A second non-attendance workflow is created purely via admin chat — no MyClaw code change. **This is the architectural validation gate.**

## The validation test

Before declaring this done, confirm Pramod can dictate **5–10 different HR instructions** over 2 weeks (attendance, reminders, onboarding a new joiner, birthday wishes, PTO collisions, exit interviews, etc.). Each should land as a working workflow with **zero TypeScript change**. Some may need a new CLI on the VM — that's fine, that's the model. If it holds, the next virtual teammate is configuration, not a project.

## What happens in parallel (not in MyClaw)

VM provisioning is Srinivas's scope and lives in a sibling repo (provisioning playbook):
- Install MyClaw + `gworkspace` + `slack-cli` + `onecli` + `gh` with pinned versions
- Register Rahul's credentials in OneCLI per-CLI
- Generate (or hand-author) `capabilities.md` that matches the installed CLIs

PR 4 can't close until the VM is up and the capability manifest is real.

## Open questions still blocking

- Baseline Bash rate limits — exact budgets per CLI (DMs/hour, Gmail sends/day)?
- Google Workspace OAuth scope — domain-wide delegation or per-user consent?
- Slack CLI — which package (vendor vs. community)?
- Capability manifest — generated by provisioning, or hand-authored, or discovered via `which`?
- First non-Rahul use case to force extensibility beyond HR?
