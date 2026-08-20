---
status: proposed
confirmed_by: ""
date: 2026-08-05
stories: [GANTRY-BROWSER-RUNTIME]
---

# Shared Hosted Browser Automation

## Context

Gantry already owns the canonical `Browser` capability, persistent browser
profiles, signed browser IPC, scheduled jobs, and browser audit events. Hosted
applications such as ATS and ITOps need unattended browser work as well as an
interactive login path. Running an application-specific browser ECS service
duplicates those lifecycle and policy responsibilities and gives every
application another browser fleet to operate.

The existing Browser gateway is oriented around visible, agent-driven page
actions. The fleet image does not currently install Chromium or a virtual
display, and the gateway deliberately has no download action. Those gaps keep
hosted scheduled jobs from replacing application-owned browser workers.

## Decision

Extend the canonical `Browser` capability for hosted scheduled jobs: the
official Gantry runtime image will include Chromium and a virtual display, and
the Browser gateway will support a bounded download action that stores files
under the run browser artifact root. Hosted login/viewer exposure remains an
explicit deployment setting and never grants browser or control-plane
authority.

Application-specific navigation and persistence remain outside Gantry core.
Applications supply reviewed skills/prompts and scoped MCP/API tools; Gantry
owns browser execution, profiles, job lifecycle, artifacts, policy, and audit.
Browser jobs never receive an application's database credential.

## Consequences

- ATS and future ITOps workflows can share one Gantry browser runtime without
  sharing profiles, application credentials, or database access.
- A download must originate from an inspected page target, be size/time
  bounded, and return only a Gantry artifact reference.
- Hosted images become larger and browser jobs consume Gantry worker capacity;
  queue limits and browser-profile leases remain the isolation mechanisms.
- noVNC or an equivalent viewer may be enabled by deployment configuration,
  but the Browser capability stays the only durable browser authority.
- Existing `browser_open`, `browser_inspect`, `browser_act`, and
  `browser_close` contracts remain valid.
