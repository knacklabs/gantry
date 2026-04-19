# Rahul HR Agent — Architecture

**Status:** Draft v3 · **Date:** 2026-04-17 · **Owners:** Tushar (platform work), Tejas (agent config), Ravi (direction)

> **v3 (2026-04-17):** Swapped custom MCP tool servers for CLIs-on-VM + Bash + OneCLI, per Ravi's framing. Capabilities are a provisioning concern, not an integration concern. See [docs/plans/agent-platform.md](../../plans/agent-platform.md).
>
> **v2 (2026-04-17):** Reflected host-first runtime (container mode removed), `settings.yaml` SSOT, OneCLI per-agent onboarding, `bootstrap/` layer, Mini App removal.

## Context

CEO-sponsored initiative: add a virtual employee **Rahul** (`rahul@caw.tech`) — a MyClaw agent on a GCP VM — appearing in Slack like a real teammate, reporting to Pramod in HR.

**Day-1 responsibilities:** daily attendance pings (office / WFH / leave), project + allocation % collection, self-appraisal form reminders.

**Critical constraint from CEO:** this must NOT be designed as an attendance bot. Rahul must be **autonomous and configurable** — an admin issues instructions in a channel, the agent picks tools and executes. Attendance is use case #1; reminders, emails, and other HR flows come later. **Extensibility is the requirement.**

## Mental model

Not a chatbot. **A "virtual teammate" platform, instantiated as Rahul.** The product is the pattern; Rahul is the first deployment.

**Rahul is configuration, not software.** The *platform* ([docs/plans/agent-platform.md](../../plans/agent-platform.md)) is the software; Rahul is a folder of YAML + Markdown + the right CLIs installed on his VM.

**Capabilities come from CLIs, not integrations.** Rahul's "Google Sheets access" isn't code we wrote — it's the `gworkspace` CLI installed on his VM, credentials wrapped by OneCLI, and Claude composing `gworkspace sheets append ...` via the `Bash` tool. The same way a real junior employee uses the same tools everyone else does.

## Layered view

```
┌──────────────────────────────────────────────────────────────┐
│  INTERFACES          Slack (DM + channels) · Email · Sheets  │
├──────────────────────────────────────────────────────────────┤
│  CONTROL PLANE       Admin intake · Workflow registry ·      │
│                      Scheduler · Channel-native approval     │
├──────────────────────────────────────────────────────────────┤
│  AGENT CORE          Claude Agent SDK · Dialog manager ·     │
│                      Tool selection · Per-employee memory    │
├──────────────────────────────────────────────────────────────┤
│  CAPABILITIES        Bash → CLIs on VM:                      │
│                      gworkspace · slack-cli · onecli · gh    │
├──────────────────────────────────────────────────────────────┤
│  STATE               Employees · Workflows · Conversations · │
│  (durable)           Audit log · Memory · Secrets via OneCLI │
├──────────────────────────────────────────────────────────────┤
│  RUNTIME             GCP VM · Host process · systemd ·       │
│                      OneCLI agent identity per group         │
└──────────────────────────────────────────────────────────────┘
Cross-cutting: observability, rate limits, permissions, guardrails
```

## Runtime model (host-first)

- **Host-runtime, single Node.js process.** MyClaw per [ADR 2026-04-16](../../decisions/2026-04-16-runtime-truth-host-first.md) runs agents as host processes, not Linux containers. Container runtime is deferred future work.
- **Isolation is logical**, not container-level: per-group memory directory, per-group OneCLI agent identity for secrets, per-group session in SQLite, per-group message queue ([group-queue.ts](../../../apps/core/src/runtime/group-queue.ts)).
- **Security depends on host trust boundaries** — scoped filesystem mounts, OneCLI-injected credentials for CLI invocations, `settings.yaml` sender allowlists, Bash safety hook, systemd-level process constraints on the VM.

## Components

### 1. Identity & Presence

- Slack bot user: display name "Rahul", real photo, HR-junior title, timezone
- Pre-joined to `#general`, `#hr`, and admin channel `#hr-rahul`
- `rahul@caw.tech` Gmail mailbox (send + receive via `gworkspace gmail` CLI)
- One-time `#general` intro post on first boot — driven by `agents/rahul/intro.md` template

### 2. Control Plane — how you talk to Rahul

| Piece | Purpose | Backing MyClaw piece |
|---|---|---|
| **Admin channel** (`#hr-rahul`) | Only surface where behavior can change | `settings.yaml` sender allowlist + new policy hook |
| **Intent parser** | NL instruction → structured `WorkflowSpec` | New `workflow/intake.ts` subagent |
| **Confirmation loop** | Rahul echoes spec, asks for approval | [bootstrap/channel-wiring.ts](../../../apps/core/src/bootstrap/channel-wiring.ts) `requestUserAnswer` |
| **Workflow registry** | Durable store; list/pause/edit/delete via chat | New `workflow/store.ts` + `workflows` SQLite table |
| **Scheduler** | Cron-like; triggers workflow runs | Existing [task-scheduler.ts](../../../apps/core/src/runtime/task-scheduler.ts) |
| **Approval gates** | First run = dry-run + admin confirm | `requestPermissionApproval` (Slack Block Kit / inline buttons) |
| **Bash safety hook** | Rate-limit + dangerous-pattern block on CLI invocations | New `runtime/hooks/policy.ts` |

### 3. Agent Core

- Claude (via Claude Agent SDK) with a system prompt defining: persona, manager (Pramod), guardrails, and the **capability manifest** (`agents/rahul/capabilities.md` listing which CLIs are installed and how to use them)
- **Tool-use loop**: receives event → decides next action → invokes Bash/Read/etc. → observes → decides again
- **Dialog manager**: per-employee thread state, multi-turn (e.g., WFH → project → allocation), disambiguates — backed by new `conversation_state` table
- **Memory scoping**:
  - *Workflow memory* (disposable, per run)
  - *Employee memory* (durable profile: name, manager, timezone, active projects)
  - *Global memory* (org chart, policies, the capability manifest itself)

### 4. Capabilities — CLIs on the VM, driven via Bash

**Not** custom MCP servers. Rahul's capabilities are determined by **what's installed on the VM**.

| CLI | What Rahul can do with it | Credentials via |
|---|---|---|
| `gworkspace` | Read/write Google Sheets, send Gmail, check Forms, read Calendar | `onecli exec -- gworkspace ...` |
| `slack-cli` | Send DMs, post to channels, read threads, react, list users (for operations beyond what MyClaw's channel layer handles) | `onecli exec -- slack-cli ...` |
| `onecli` | Credential-wrapping execution for any CLI | self |
| `gh` | GitHub operations (if HR workflows ever touch PRs/issues) | `onecli exec -- gh ...` |
| Built-in SDK tools | `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch` | n/a |

**Adding a capability (e.g., Jira):** install `jira-cli` on the VM, add it to OneCLI, update `capabilities.md`. Zero MyClaw code change.

**Roster** — source of truth is a Google Sheet (`Employees 2026`). Rahul reads it via `gworkspace sheets read` when he needs to enumerate people. No separate directory system, no `employees` DB table required for v1.

### 5. State (durable, survives restarts)

- **`workflows`** — id, owner (admin who created), spec (JSON), schedule, status, last run
- **`workflow_runs`** — per-execution: started, finished, targets, responses, errors
- **`conversation_state`** — open DM threads with FSM position (e.g., "awaiting project")
- **`audit_log`** — every `Bash` command Rahul runs (tool, full command, result, principal, workflow_run_id) — append-only. This is the main audit surface in the CLI model.
- Existing `memory_items` table — per-user facts, procedures

SQLite on the VM is enough for v1; Postgres if multiple instances later.

### 6. Runtime

- GCP VM (Srinivas) mirroring MyClaw host-runtime baseline
- **Single Node.js process** under systemd (restart on crash) — no container runtime
- **VM provisioning script** (Srinivas's real scope): installs `node`, MyClaw, `gworkspace`, `slack-cli`, `onecli`, `gh`. Pins CLI versions. Registers OneCLI credentials per CLI
- **OneCLI agent identity** per group (see [bootstrap/runtime-app.ts:66-83](../../../apps/core/src/bootstrap/runtime-app.ts#L66-L83)) — Rahul's Google/Gmail/Sheets creds live under `rahul` in OneCLI, never in env or disk
- Outbound-only initially (Slack Events API via socket mode; no public inbound webhooks)

### 7. Cross-cutting concerns

- **Observability**: every workflow run posts a digest in `#hr-rahul` ("Attendance Apr 16: 42/47 replied, 3 pending — [thread]") — built from `audit_log` + a digest step type
- **Rate limits**: **Bash policy hook** watches for CLI invocations that touch external services (e.g., `slack-cli dm`, `gworkspace gmail send`). Caps: DMs/hour, Gmail sends/day, Sheets writes/minute. Blocks runaway loops
- **Permissions**: only messages in `#hr-rahul` or DMs from the admin list can create/modify workflows — enforced by policy `PreToolUse` hook reading `settings.yaml` allowlist + `admin_channels` list
- **Credential enforcement**: policy hook requires credentialed CLIs to be invoked via `onecli exec -- <cli>`; rejects raw invocation
- **Failure surfacing**: ambiguous reply, timeout, or non-zero exit from a CLI escalates to Pramod in-thread — never silently dropped
- **Kill switch**: `@rahul stop` in `#hr-rahul` pauses all workflows immediately

## User flows

### Admin flow — Pramod configures

> **Pramod** (in `#hr-rahul`): "Every weekday 10am, DM everyone asking if they're in office / WFH / leave. If working, ask project and allocation %. Log to the Attendance sheet. Send me the summary by noon."
>
> **Rahul**: "Got it — first run Monday 10am, 47 people from the Employees sheet, logs to *Attendance 2026*, summary at noon. Confirm?"
>
> **Pramod**: taps "Approve" on Slack Block Kit confirmation
>
> → workflow saved + scheduler armed

### Employee flow — natural conversation

> **Rahul** (DM to Priya): "Morning! Office, WFH, or leave today?"
>
> **Priya**: "wfh, working on the billing revamp, 80%"
>
> → Rahul parses all three, runs `onecli exec -- gworkspace sheets append ...`, marks conversation done.

### Ad-hoc flow — one-shot delegation

> **Pramod**: "Remind anyone who hasn't filled the April self-appraisal."
>
> **Rahul**: runs `onecli exec -- gworkspace forms responses --form April-Appraisal`, diffs against roster Sheet, DMs the gap, reports back: "reminded 12 people, 3 already replied they'll do it today."

No new MyClaw code. Rahul composed the right CLI calls from his capability manifest.

## Request lifecycle — end-to-end

```
Pramod (in #hr-rahul): "Daily at 10am, ask everyone their work status..."
  │
  ▼
[Policy hook] PreToolUse check — admin channel → allowed
  │
  ▼
[Intake subagent] parse → WorkflowSpec{name: attendance-daily, cron: "0 10 * * 1-5",
                                        audience: sheet:Employees, steps: [...]}
  │
  ▼
[Confirm] Rahul: "Got it..." (via requestUserAnswer / Slack Block Kit)
  │
  ▼ (Pramod approves)
[Store] workflow saved + scheduler armed
  │
  ▼ (Monday 10am)
[Scheduler] fires → [Engine] runs workflow
  │
  ▼ for each employee (rate-limited by Bash policy hook)
[Claude: Bash] "onecli exec -- slack-cli dm U_PRIYA 'Morning! ...'"
  │
  ▼ [Conversation FSM parks: awaiting_status]
  │
  ▼ employee replies "wfh, billing, 80%"
[Engine resumes] → parses → [Claude: Bash] "onecli exec -- gworkspace sheets append ..."
  │
  ▼ at noon
[Digest step] → [Claude: Bash] "onecli exec -- slack-cli post #hr-rahul '...'"
  │
  ▼ (throughout)
[Audit hook] PostToolUse → append-only audit_log rows of every Bash invocation
```

## Key design tensions

- **Bash is a sharp knife.** Typed MCP tools would enforce rate limits for free. Bash can loop. Therefore the **policy hook is load-bearing** — must catch runaway loops, dangerous patterns, un-wrapped credentials. Worth prioritizing in PR 3.
- **Scope of autonomy**: first-run approval via Slack button; auto-run after. Pramod can pause/revoke from `#hr-rahul`.
- **Memory model**: per-employee state (last attendance, project) vs. per-workflow state. Keep separate so workflows are disposable but employee context persists.
- **Failure visibility**: any CLI non-zero exit, ambiguous reply, or timeout escalates to Pramod. Don't silently drop.
- **Guardrails**: only admin channel can change behavior; employee DMs can only answer questions Rahul asked.

## Build order

Rahul rides on the platform build plan ([docs/plans/agent-platform.md](../../plans/agent-platform.md)). Rahul-specific work is thin:

1. **Provision GCP VM** (Srinivas) with: MyClaw host runtime, `gworkspace`, `slack-cli`, `onecli`, `gh`, pinned versions, OneCLI credentials registered per CLI
2. **Register `rahul` group** — folder under `agents/rahul/` with `CLAUDE.md`, memory seed, `config.yaml`, `capabilities.md`, `intro.md`
3. **Seed roster Sheet** — 47 employees in `Employees 2026` Google Sheet (no DB seeding required)
4. **Connect Slack app** with Rahul's bot user + photo
5. **Pramod kicks the tires** — creates the attendance workflow via chat (requires platform PR 3)
6. **Validation** — after platform PR 4, Pramod creates a non-attendance workflow (appraisal reminders via `gworkspace forms`) with zero MyClaw code change. This is the architectural test.

Rahul's readiness is gated by **platform PRs 1–4**.

## Validation test

Before declaring success, confirm Pramod can dictate **5–10 different HR instructions** over 2 weeks (attendance, reminders, onboarding a new joiner, birthday wishes, PTO collision checks, exit interview scheduling, etc.). Each should land as a working workflow with **zero MyClaw code change**. Some may require a new CLI install on the VM (e.g., `linear-cli` for onboarding ticket creation) — but not TypeScript. If this holds, **the architecture is right and the next virtual teammate is 30 minutes of YAML + a provisioning run**.

## Ownership

| Person | Responsibility |
|---|---|
| Tushar | Drive platform PRs 1–3 in MyClaw |
| Tejas | Create/configure Rahul — `config.yaml`, `capabilities.md`, prompting, workflow specs |
| Ravi | Direction + troubleshooting; already shipped `settings.yaml` SSOT + OneCLI onboarding |
| Srinivas | Provision GCP VM + CLI installation playbook + OneCLI credential registration per CLI |
| Pramod | Product owner (HR lead Rahul reports to) |

## Open questions

- Which MyClaw tag/commit is the baseline for the VM? (recommend post-PR #7 merge at minimum)
- Which exact CLI packages go in the baseline image? `gworkspace` → [googleworkspace/cli](https://github.com/googleworkspace/cli); Slack CLI — vendor or community?
- Google Workspace OAuth scope — domain-wide delegation, or per-user consent?
- Baseline Bash rate limits — DMs/hour, Gmail sends/day, Sheets writes/minute?
- How is the capability manifest (`capabilities.md`) kept in sync with what's actually installed? (Provisioning playbook generates it? Or Rahul discovers CLIs via `which` on boot?)
- How does Rahul handle contractors / ex-employees still in Slack?
- Dry-run/sandbox mode for testing new workflows before going live?
- First non-Rahul use case to force extensibility? (recommend naming one now even if 3 months out)
