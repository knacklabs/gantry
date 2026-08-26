---
slug: ai-employee-directory
title: AI employee directory
status: confirmed
saved: 2026-08-26T11:07:54+00:00
---

# AI employee directory

## Capability

An IT administrator opens one directory of the organisation's AI employees and sees,
for each: its seats (channel installs and provider accounts), its accounts (connector
accounts), its access (access preset and tool rules summary), its owner and approvers,
its status, its monthly usage, and its audit trail — and can pause, resume, or offboard
it from the same page. The directory is the console's `/agents` page made live.

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
  call paths are not yet counted until complete accounting lands (V1.1 hard cap).

### Browser surface

- Same-origin facades per decision 0132/0135: `/ui/api/agents` (viewer read;
  administrator mutation with CSRF, Origin, recent re-authentication, audit) and
  `/ui/api/activity` (viewer read). Browser sessions never call `/v1/*`.
- Offboard calls the atomic offboard use case and shows the resulting audit row.
  Pause/resume is available to the agent's owner and administrators.
- Heading vocabulary: "AI employees" on the page; "agent" everywhere in API and CLI.

## Acceptance criteria

- **UIFACADE-1** — Browser facades: live agents and audit read models
  - /ui/api/agents with Viewer read and Administrator mutation, CSRF, Origin, reauth, audit per ADR 0132/0135
  - /ui/api/activity live, agent-filterable audit read model replacing runtime-preview fixtures
  - Directory read model: agent, aliases, installs, status, access summary
- **DIR-UI-1** — Directory UI: agents, access, audit, offboard
  - Directory lists agents with aliases, installs, and status
  - Offboard action calls the atomic offboard use case and shows the audit row
  - Offboard button calls the IDENT-2 atomic offboard use case through /ui/api/agents with reauth; audit row shown from the live activity facade
- **COST-1** — Per-agent usage view
  - Usage view per agent in the directory using /v1/usage grouped by agent and calendar month
  - View is labelled with which model-call paths are not yet counted until COST-2 completes accounting
  - No USD price table

## Source

Grill 2026-08-26 (Q6, Q8, Q24, Q27; COST split after gap sweep). Stories:
UIFACADE-1, DIR-UI-1, COST-1.
