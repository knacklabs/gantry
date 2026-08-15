---
slug: preflight-1
title: PREFLIGHT-1 Scheduled jobs declare their tools upfront (neutral) + actionable setup cards
status: confirmed
saved: 2026-08-09T04:30:00+00:00
---

# PREFLIGHT-1 — Scheduled jobs declare their tools upfront, and setup cards are actionable

## Problem

A scheduled job runs as its agent and inherits the agent's granted tools, but nothing
captures the tools the *task* will need. `access_requirements` is optional and almost
always omitted, so creation-time readiness trivially passes even when the task will need
a tool the agent lacks — the gap is only discovered when a scheduled run hits the tool
and pauses. Worse, when that pause fires for a builtin facade tool (WebSearch, WebRead,
FileRead, Browser, FileWrite, FileEdit) the "Setup needed" card is instruction-only —
no grant button — because the shared recovery generator misclassifies canonical facade
tools as forbidden raw SDK grants. The owner gets a dead-end message. Verified live and
in code across both runner lanes.

## Intent

- Any tool the owner can legitimately grant produces a one-tap grant button on the setup
  card, uniformly across the DeepAgents and Anthropic-SDK lanes (no lane-specific fix).
- When an agent schedules a job, it declares the tools the task will need, so a missing
  tool surfaces as an actionable card shortly after creation — not mid-run. Creation
  stays silent and fast.
- No worker/agent self-grant (authority stays host-reviewed, PERM-2). The runtime pause
  remains the fallback for under-declared tools and run-time-only checks.

## Acceptance

- A scheduled pause on an ungranted builtin facade tool shows a one-tap grant button on
  both lanes; tapping durably grants the canonical selection (never the raw SDK alias)
  and appends the canonical job requirement. Third-party MCP / locked / fixed-image stay
  instruction-only.
- Scheduling a job whose task needs an ungranted tool declares it and yields an actionable
  card shortly after creation; a job needing only granted tools is ready with no card.
- Setup cards use bounded durable delivery (cap 4) with defined recovery for delivered,
  ambiguous, exhausted, expired, and cancelled outcomes; delivery failure is never a
  human denial. The passive setup event is kept.
- Behaviour is identical regardless of runner lane; no prime/`runMode` code is introduced.

## Source

Live reproduction on the KnackLabs Lead Maintenance job + three read-only investigations
and a neutrality/duplication/legacy validation. Prime-based auto-discovery was evaluated
and rejected (Anthropic-lane-only, would execute tools for real on DeepAgents, half-wired,
duplicative). Belongs to the permission-engine epic.
