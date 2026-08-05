---
slug: shared-hosted-browser-automation
title: Shared hosted browser automation
status: confirmed
saved: 2026-08-05T11:13:07+00:00
---

# Shared hosted browser automation

## Capability

An application-bound Gantry agent can run an unattended scheduled Browser job
inside the official fleet runtime, reuse its isolated persistent browser
profile, download a file into the run artifact boundary, and call only the
application capabilities selected for that agent. ATS is the first consumer;
ITOps can add a separate agent, profile, skill, and API capability later.

## Behaviour

1. Fleet Chromium starts through Gantry's existing host-owned Browser lifecycle
   on an opt-in virtual display; agent tools do not receive a headless switch.
2. `browser_act` can request a download only with `profile: full`, a reason,
   and a page target from inspection or a unique selector.
3. The host arms the download before clicking, confines the saved file to the
   run browser artifact root, bounds time and bytes, sanitizes filenames, and
   returns an opaque file reference rather than inline bytes or a host path.
4. Browser profile, job lease, selected capability, permission, audit, and
   cleanup rules remain the same as other canonical Browser actions.
5. An application workflow reaches business data only through selected,
   scoped MCP/API capabilities. Browser jobs never receive application DB
   credentials.

## Non-goals

- Application-specific scraping logic in Gantry core.
- Arbitrary shell-script execution as Browser authority.
- AWS load balancer, ECS service, DNS, or secret changes.
- Removing an existing application worker before application-owned parity
  validation.

## Constraints

- Preserve decision 0012's canonical Browser and visible headed-session model.
- Reuse the existing artifact root and cross-worker profile snapshot model.
- Keep workstation behavior unchanged unless hosted virtual display is
  explicitly enabled.
