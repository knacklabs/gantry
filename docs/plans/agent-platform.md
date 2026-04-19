# Agent Platform Build Plan

**Status:** Draft v3 · **Date:** 2026-04-17 · **Scope:** MyClaw repo

> **v3 (2026-04-17):** Swapped custom MCP capability servers for CLIs-on-VM + `Bash` tool + OneCLI credential wrapping, per Ravi's framing. Capabilities are now a provisioning concern, not an integration concern. Safety hooks on `Bash` become the firewall.
>
> **v2 (2026-04-17):** Reflected PR #2 → PR #7 changes: settings.yaml SSOT, MIG-001 host-first runtime, architecture fitness checks, OneCLI credential onboarding, Mini App removal.

## Goal

Turn MyClaw from "a runtime that runs agents" into an **autonomous admin-configurable agent platform**: an admin issues instructions in a channel, the agent parses intent, picks tools, and executes structured, durable workflows. Attendance, HR reminders, ops follow-ups — all as configurable workflows, not bespoke code.

## Guiding principles (2026-native)

- **Capabilities come from CLIs on the VM, not integration code.** Claude Agent SDK's built-in `Bash` is the execution surface. Install `gworkspace`, `gh`, `slack-cli`, etc. on the VM; Claude drives them like a real operator. Vendor owns the glue.
- **OneCLI wraps credential injection** at command-exec time (`onecli exec -- <cli>`). Tokens never touch our code.
- **Zod-typed `WorkflowSpec` + structured LLM output** for workflow recipes — no custom DSL, no YAML parser
- **Claude Agent SDK hooks + subagents** — leverage what's already wired; `PreToolUse` on `Bash` is the safety firewall
- **SQLite-backed checkpointing** — suspend/resume via the existing scheduler; defer Temporal until multi-tenant or 10+ active workflows
- **Channel-native approvals** — `requestPermissionApproval` / `requestUserAnswer` in [bootstrap/channel-wiring.ts](../../apps/core/src/bootstrap/channel-wiring.ts). The old Mini App approval UI is gone (PR #7)

## The capability model (this is the big shift)

Do not build `sheets/`, `gmail/`, `forms/`, `http/` MCP servers. Instead:

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Agent SDK (in MyClaw)                               │
│    Built-in tools: Bash, Read, Write, Edit, Glob, Grep,     │
│                    WebSearch, WebFetch                      │
└──────────────────────────┬──────────────────────────────────┘
                           │ Bash
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  VM host — CLIs installed via provisioning:                 │
│    gworkspace    Google Sheets / Gmail / Calendar           │
│    gh            GitHub                                     │
│    slack-cli     Slack operations                           │
│    onecli        Credential-wrapped execution               │
│    <vendor>-cli  Anything that ships a CLI                  │
└─────────────────────────────────────────────────────────────┘
```

Claude reads each CLI's `--help`, composes commands, parses `--output=json`. It already does this very well — it's the core Claude Code training target.

**Adding a new capability = install a CLI on the VM.** No code change in MyClaw.

**Roster** — company-specific, no CLI. Source of truth is a Google Sheet; Claude reads it via `gworkspace sheets read`. Still zero integration code.

## What's already in place (do not rebuild)

### Runtime bootstrap (PR #6, host-first per ADR 2026-04-16)

| Responsibility | Location |
|---|---|
| Startup orchestration (layout, DB, settings, state, OneCLI agents) | [apps/core/src/bootstrap/startup.ts](../../apps/core/src/bootstrap/startup.ts) |
| `RuntimeApp` factory — channels, queue, state, group processing | [apps/core/src/bootstrap/runtime-app.ts](../../apps/core/src/bootstrap/runtime-app.ts) |
| Channel wiring + permission-approval + user-answer primitives | [apps/core/src/bootstrap/channel-wiring.ts](../../apps/core/src/bootstrap/channel-wiring.ts) |
| Runtime services (scheduler, IPC, message polling, session cleanup) | [apps/core/src/bootstrap/runtime-services.ts](../../apps/core/src/bootstrap/runtime-services.ts) |
| Shutdown orchestration | [apps/core/src/bootstrap/shutdown.ts](../../apps/core/src/bootstrap/shutdown.ts) |
| Credential onboarding (env ↔ OneCLI migration) | [apps/core/src/cli/setup-credentials.ts](../../apps/core/src/cli/setup-credentials.ts) |

### Settings (PR #3 — SSOT cutover is DONE)

- [apps/core/src/cli/runtime-settings.ts](../../apps/core/src/cli/runtime-settings.ts) owns the `settings.yaml` schema, load, validate, write
- Current schema: `channels.{telegram,slack}.{enabled, sender_allowlist}` + `features.{memory, embeddings, dreaming}`
- Secrets (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `TELEGRAM_BOT_TOKEN`, Anthropic) stay in `.env` — validation cross-checks them when a channel is enabled

### Agent runtime

| Capability | Location | Notes |
|---|---|---|
| Host-runtime agent spawn | [apps/core/src/runtime/agent-spawn.ts](../../apps/core/src/runtime/agent-spawn.ts), [apps/core/src/runtime/agent-spawn-host.ts](../../apps/core/src/runtime/agent-spawn-host.ts) | Container mode removed ([ADR](../decisions/2026-04-16-runtime-truth-host-first.md)) |
| Job scheduler (cron/interval/once/manual) | [apps/core/src/runtime/task-scheduler.ts](../../apps/core/src/runtime/task-scheduler.ts) | Full lifecycle, retries, dead-letter |
| Memory (SQLite + semantic) | [apps/core/src/memory/memory-service.ts](../../apps/core/src/memory/memory-service.ts) | Facts, procedures, archives |
| Slack / Telegram channels | [apps/core/src/channels/slack.ts](../../apps/core/src/channels/slack.ts), [apps/core/src/channels/telegram.ts](../../apps/core/src/channels/telegram.ts) | Self-register via [apps/core/src/channels/registry.ts](../../apps/core/src/channels/registry.ts) |
| IPC-MCP tool bridge | [apps/core/src/runtime/ipc.ts](../../apps/core/src/runtime/ipc.ts), [packages/agent-runner/src/ipc-mcp-stdio.ts](../../packages/agent-runner/src/ipc-mcp-stdio.ts) | Retained for **platform-internal** tools (workflow store ops, roster lookup, etc.) — not for external capabilities |
| OneCLI per-agent identity | [apps/core/src/bootstrap/runtime-app.ts:66-83](../../apps/core/src/bootstrap/runtime-app.ts#L66-L83) | Each non-main group gets its own OneCLI agent identifier |
| Architecture fitness enforcement | [.codex/scripts/architecture_rules.py](../../.codex/scripts/architecture_rules.py) | New modules must conform or get an exception |

## New modules to create (in MyClaw repo)

### 1. Workflow schema + store (keystone)
- **`apps/core/src/workflow/schema.ts`** — Zod `WorkflowSpec`: `{ id, name, trigger: Cron|Event|Manual, audience: RosterSelector, steps: Step[], outputs, approvals }`. Step types include `ask_and_collect`, `run_task` (freeform, Claude picks CLIs), `wait_until`, `branch`, `escalate`, `digest`
- **`apps/core/src/workflow/store.ts`** — CRUD over new `workflows` table; JSON spec column; status `draft|approved|active|paused|archived`
- **`apps/core/src/workflow/engine.ts`** — step executor, one step per tick, checkpoints after each. Uses scheduler for cron triggers + suspend/resume. For `run_task` steps, hands Claude the goal in English and lets him compose Bash + CLI commands

### 2. Conversation checkpointing
- **`apps/core/src/workflow/conversation.ts`** — per-`(workflow_run_id, user_id)` FSM: `fsm_node`, `awaiting_schema`, `timeout_at`, `retries`. Inbound message resumes at cursor; timeout fires escalate step
- Replaces implicit "message history = state" pattern in [apps/core/src/runtime/group-processing.ts](../../apps/core/src/runtime/group-processing.ts)

### 3. Intake subagent
- **`apps/core/src/workflow/intake.ts`** — Claude Agent SDK subagent with a single `emit_workflow_spec` tool (Zod-schema-backed). Admin message → structured spec → confirmation echo → save. Context-isolated

### 4. Hook-based policy + audit (this is load-bearing)
- **`apps/core/src/runtime/hooks/policy.ts`** — `PreToolUse` hook. Responsibilities:
  - Block workflow-mutating calls outside the admin channel
  - **Rate-limit `Bash` commands that touch external services** (watch patterns like `slack-cli dm`, `gworkspace gmail send`, loops, `xargs`)
  - Block dangerous shell patterns (`rm -rf`, `sudo`, raw network tools)
  - Require `onecli exec` wrapping for any credentialed CLI
- **`apps/core/src/runtime/hooks/audit.ts`** — `PostToolUse` + `PostToolUseFailure` → append-only `audit_log` (tool, command, result, principal, workflow_run_id). Every Bash invocation recorded
- Wired in [packages/agent-runner/src/index.ts](../../packages/agent-runner/src/index.ts) via the SDK's hook API

### 5. Per-agent config + persona + capability manifest
- **`~/myclaw/agents/{name}/config.yaml`** (new) — `persona` (displayName, photoUrl, title, introTemplate), `adminChannel`, `allowedCLIs` (list of CLI names the agent may invoke), `guardrails` (rate limits, dangerous-pattern overrides), `secrets` (symbolic OneCLI keys)
- **`~/myclaw/agents/{name}/capabilities.md`** (new) — human-authored capability manifest injected into the agent's system prompt: "You have access to `gworkspace`, `slack-cli`, `onecli`. Here's how each works. Always wrap credentialed calls with `onecli exec -- ...`."
- **`apps/core/src/agents/persona.ts`** — applies persona at bootstrap: Slack `users.setPhoto` / `users.profile.set`, posts intro template to `#general` on first registration; loads capabilities.md into system prompt

## VM provisioning (new, out-of-repo concern)

Capabilities now live on the VM filesystem. This needs an explicit provisioning story:

- **Ansible playbook or `Dockerfile`-style script** that installs the baseline CLIs per agent role (HR agent → `gworkspace` + `slack-cli`; engineering agent → `gh` + `gcloud`; etc.)
- **OneCLI vault setup** — each CLI's credentials registered under the agent's OneCLI identifier
- **CLI version pinning** — so Claude's learned invocation patterns don't break on upstream changes
- Lives in a sibling repo (e.g., `myclaw-ops` or `rahul-vm-provisioning`) — not in MyClaw itself

**This is Srinivas's real scope.** Provisioning the VM = more than `apt install node`; it's defining the capability surface.

## Extensions to existing files

- **[apps/core/src/storage/db.ts](../../apps/core/src/storage/db.ts)** — migrations for: `workflows`, `workflow_runs`, `conversation_state`, `audit_log`, `employees` (optional; roster can also live as a Google Sheet read via `gworkspace`)
- **[apps/core/src/cli/runtime-settings.ts](../../apps/core/src/cli/runtime-settings.ts)** — extend `RuntimeSettings` with an optional `admin_channels` section and workflow feature flag, backward compatible
- **[apps/core/src/bootstrap/channel-wiring.ts](../../apps/core/src/bootstrap/channel-wiring.ts)** — add a workflow-aware approval path that routes "first run of workflow X?" via `requestPermissionApproval` (Slack Block Kit / Telegram inline buttons)
- **[apps/core/src/runtime/task-scheduler.ts](../../apps/core/src/runtime/task-scheduler.ts)** — add `suspendRun()` / `resumeRun()` primitives the engine calls on `ask_and_collect` or `wait_until`
- **[apps/core/src/channels/slack.ts](../../apps/core/src/channels/slack.ts)** — add kill-switch command `@bot stop` that pauses all active workflow runs. Persona photo-setting can stay here OR move to Slack-CLI invocation — pick the simpler path at implementation time

## Database migrations (new tables)

| Table | Purpose |
|---|---|
| `workflows` | id, owner, spec (JSON), status, schedule, admin_channel_id, created_at, updated_at |
| `workflow_runs` | id, workflow_id, started_at, finished_at, step_cursor, state (JSON), status |
| `conversation_state` | run_id, user_id, fsm_node, awaiting_schema, timeout_at, retries |
| `audit_log` | id, ts, principal, tool (usually `Bash`), command, result_kind, workflow_run_id — append-only |

`employees` table is **optional**. Alternative: source of truth is a Google Sheet, Claude reads it via `gworkspace sheets read "Roster"`. Skip a DB table if the Sheet approach suffices for v1.

## Sequenced build order — 4 PRs (was 5; MCP-tools PR is gone)

### PR 1 — Schema + store + migrations
- `workflow/schema.ts`, `workflow/store.ts`, DB migrations, Zod types
- No behavior change; foundation only
- **Done when:** unit tests round-trip a `WorkflowSpec` through SQLite; passes `.codex/scripts/check_architecture.py`

### PR 2 — Engine + conversation checkpointing
- `workflow/engine.ts`, `workflow/conversation.ts`, scheduler suspend/resume
- `run_task` step type: engine hands Claude the goal + the capability manifest; Claude chooses Bash+CLI commands
- One hardcoded test workflow proves the loop end-to-end (can use a fake CLI or `echo` commands for the test)
- **Done when:** fixture workflow runs end-to-end, parks on `ask_and_collect`, resumes on inbound message, logs command-level actions

### PR 3 — Intake subagent + admin channel gate + Bash safety hook
- `workflow/intake.ts`, `runtime/hooks/policy.ts`; extend `runtime-settings.ts` with `admin_channels`
- **Bash policy hook is the big new surface here.** Rate limits, dangerous-pattern blocks, `onecli exec` enforcement for credentialed CLIs
- Admin can now create a workflow from chat; unsafe Bash commands get blocked
- **Done when:** admin types an instruction in admin channel, workflow lands in DB, scheduler arms; a workflow that tries `for user in ...; do slack dm ...; done` gets rate-limited by the hook

### PR 4 — Persona + capability manifest + audit + polish
- `agents/persona.ts`, per-agent `config.yaml` loader, `capabilities.md` injection into system prompt, `runtime/hooks/audit.ts`, kill switch
- Runs in parallel with VM provisioning work (Srinivas installs `gworkspace`, `slack-cli`, `onecli` on the target VM)
- **Done when:** Rahul's persona posts to #general; a second non-attendance workflow (e.g., appraisal reminders using `gworkspace forms`) is created purely via admin chat with no MyClaw code change. **Architectural validation gate.**

## Critical path

PR 3 is the architectural milestone. If an admin can type an instruction, a net-new workflow runs, and the safety hook catches abusive Bash patterns — **the design works**. PR 4 is the proof that capabilities compose via the VM's CLI surface, not code.

## Explicitly rejected choices

- **LangGraph** — Python-first; borrow the checkpointing *pattern*, not the library
- **Custom YAML/DSL** — Zod + structured LLM output covers 95% with zero parser maintenance
- **Inngest for orchestration** — step-based pricing punishes LLM retries
- **CrewAI / AutoGen** — Claude Agent SDK + subagents already covers this ground
- **Temporal (now)** — correct long-term; overkill for single-tenant SQLite. Revisit at ~10 active workflows or multi-tenant
- **Reviving the Mini App for approvals** — removed in PR #7. Use channel-native `requestPermissionApproval` / `requestUserAnswer`
- **Custom MCP servers for Sheets / Gmail / Forms / HTTP** — dropped. Vendor CLIs + Bash + OneCLI is strictly better. We own less code, and every new vendor CLI adds capability for free

## Safety tradeoffs in the CLI-as-capability model

Bash is a sharp knife. With typed MCP tools we'd get "max 60 DMs/hour" enforcement for free. With Bash, Claude could write `for user in ...; do slack dm ...; done` and blow through rate limits in seconds unless the hook catches it.

**Therefore: hooks matter more in this model, not less.** The policy hook becomes the firewall. Worth being intentional about *before* PR 1 — baseline rate limits, dangerous-pattern blocklist, and the requirement that credentialed CLIs are always invoked via `onecli exec` should be explicit from day one.

## Revisit in 6 months

- **Temporal migration** once suspend/resume-on-SQLite strains
- **Policy engine maturity** if governance needs grow (trust tiers, ring-based capabilities)
- **Sandbox/dry-run environments** for editing live workflows safely
- **Evaluation harness** for workflow specs
- **Container runtime mode** — the ADR deferred this; if it comes back, Bash runs inside a sandbox which strengthens the safety story

## Open questions

- First target channel surface — Slack only, or Slack + Telegram from day one?
- What's the first non-Rahul use case that exercises the platform? (important to force extensibility)
- Do workflow-mutating tools go through `requestPermissionApproval` (explicit per-tool approval) or is the intake-subagent confirmation echo sufficient? (probably the latter for v1)
- Baseline Bash rate-limit policy — what are the actual per-CLI budgets? (e.g., DMs per hour, Gmail sends per day)
- How is the capability manifest kept in sync with what's actually installed on the VM? (provisioning playbook generates it?)
