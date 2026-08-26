---
slug: ai-employee-directory
title: AI employee directory
status: confirmed
saved: 2026-08-26T12:04:34+00:00
---




# AI employee directory

## Capability

An IT administrator opens one directory of the organisation's AI employees and sees,
for each: its seats (channel installs and provider accounts), its accounts (connector
accounts), its access (access preset and tool rules summary), its owner and approvers,
its status, its monthly usage, and its audit trail — and can pause, resume, or offboard
it from the same page. The Directory is one page for people and AI employees with a kind filter; it
replaces the `/agents` and `/people` previews. Audit and Approvals tabs are visible
to administrators and approvers only.

## Why

IT manages people through a directory; AI employees need the same page. Today the console's agents and activity pages are fixture-backed and cannot offboard anything.

## Behaviour

### Read model

- Directory entry: agent principal, aliases by kind, conversation installs, status
  (`active | paused | disabled | offboarded`), access summary, owner, approvers,
  current-month token usage.
- Audit: live, agent-filterable activity read model replacing fixture data; each row
  shows the `PrincipalRef` actor.
- Usage: `/v1/usage` grouped by agent and calendar month. The view labels which model
  call paths are not yet counted until complete accounting lands (V1.1 hard cap). An
  optional imported price table (LiteLLM's open model-price JSON is the documented
  default) adds a currency figure beside tokens.
- Reports (V1.1): reliability, access-changes timeline, blocked actions, memory
  changes per agent; date-range audit export (CSV/JSON, hash-stamped) per agent and
  tenant-wide; SIEM sink for audit events; access-review export of every principal
  with roles, seats, accounts, model allowlist, last activity; Prometheus metrics.

### Browser surface

- Same-origin facades per decision 0132/0135: `/ui/api/agents` (viewer read;
  administrator mutation with CSRF, Origin, recent re-authentication, audit) and
  `/ui/api/activity` (viewer read). Browser sessions never call `/v1/*`.
- Offboard calls the atomic offboard use case and shows the resulting audit row.
  Pause/resume is available to the agent's owner and administrators.
- Heading: "Directory"; kind chips "People" and "AI employees"; "agent" everywhere in API and CLI.

## Acceptance criteria

- **UIFACADE-1** — Browser facades: live agents and audit read models
  - /ui/api/agents: paged directory read model (agent, service Person, aliases by kind, installs, status, access preset, tool-rules summary, owner, approvers, current-month tokens, last run) — one query, not N+1; viewer read
  - /ui/api/agents/:id and /:id/{installs,access,audit,approvals} read; /:id/status PATCH (pause|resume), /:id/owner PATCH, /:id/approvers PATCH, /:id/offboard POST — administrator or owner where the spec allows, Origin+CSRF, hosted reauth, audit
  - /ui/api/activity: live unified audit rows (time, actor PrincipalRef, action, target, conversation, outcome, source) across runtime_events, permission_audit_events, permission_decisions, mcp_server_audit_events, with agentId filter added to each source
  - /ui/api/people list/get; /ui/api/usage wrapping /v1/usage
  - Scopes classified in browser-scope-policy per decision 0132; boundary tests under apps/core/test/unit/auth/
  - /ui/api/agents/:id/audit and /:id/approvals require administrator or approver; /ui/api/activity likewise; scope policy classifies them so
- **DIR-UI-1** — Directory UI: one list for people and AI employees, detail, offboard
  - One Directory route replaces the /agents and /people previews: kind filter chips People | AI employees, search, URL state, paged table, empty state; heading 'Directory'
  - Agent detail tabs read-only in V1.0: Overview, Access (preset, tool rules, grants, sources, connector accounts), Audit (live activity filtered to the agent), Approvals (pending interactions and recent decisions, read-only)
  - Detail is the control surface: owner assignment, approver assignment, pause/resume (owner or administrator), offboard (administrator, hosted reauth, exact-name confirmation, shows the audit row); directory row exposes pause/resume as a quick action only
  - Uses existing primitives (PageHeader, Panel, DataTable, Dialog/AlertDialog, PageState); no toast system — inline receipts
  - Audit and Approvals tabs render only for administrator and approver roles; viewers see Overview and Access
  - Built from the DESIGN-1 approved mockups
- **COST-1** — Per-agent usage view
  - Usage view per agent in the directory using /v1/usage grouped by agent and calendar month
  - View is labelled with which model-call paths are not yet counted until COST-2 completes accounting
  - Usage panel on agent detail (month picker, requests, input/output tokens, uncounted-path disclosure) and a compact current-month value in the directory row via /ui/api/usage
  - Optional imported price table (LiteLLM's open model-price JSON as the documented default) enables a currency figure beside tokens; without it the view stays token-only
- **REPORT-1** — Per-agent reports and exports
  - Agent detail panels: reliability (runs started/completed/failed/timed out, p95 turn latency), access-changes timeline, blocked actions (denied tool calls, locked-posture denials, guardrail triggers), memory changes (learned, pending review, rejected)
  - Date-range audit export per agent and tenant-wide as CSV/JSON with a hash stamp; SIEM shipping of audit events (syslog/HTTP) as a configured sink
  - Access-review export: every principal (human and agent) with roles, seats, accounts, model allowlist, last activity
  - Prometheus metrics endpoint covers runs, latency, denials, handoffs, model calls by provider

## Source

Grill 2026-08-26 (Q6, Q8, Q24, Q27; COST split after gap sweep). Stories: UIFACADE-1, DIR-UI-1, COST-1, REPORT-1 (V1.1).
