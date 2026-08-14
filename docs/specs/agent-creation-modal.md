---
slug: agent-creation-modal
title: Agent Creation Modal — durable workflow and native console UX
status: confirmed
saved: 2026-08-14T05:05:59+00:00
---

# Agent Creation Modal — durable workflow and native console UX

## Why

Local Gantry operators currently need to combine several control surfaces to
create an agent. That is slow, makes partial setup easy to leave behind, and
cannot be resumed safely after a process or browser interruption. The Agents
directory needs one native console flow that saves a valid setup draft and
commits it through Gantry's existing durable authorities.

## Behaviour

- Add a compact, accessible `Create agent` icon button beside Refresh in the
  existing Agents directory. It opens a large desktop/full-height mobile
  dialog assembled from the existing Radix/shadcn primitives and Gantry
  semantic tokens; no UI dependency or copied third-party CSS is introduced.
- The dialog has a fixed header, responsive step rail, scrollable content,
  fixed footer, visible focus, reduced-motion behavior, and restrained native
  transitions. It creates only local form state until Identity is valid and an
  operator selects Save draft.
- Persist app-scoped shared drafts with optimistic `expectedRevision` updates,
  safe conflict handling, deletion before an agent exists, short safe errors,
  durable stage progress, reserved agent/job IDs, an expiring claim lease, and
  30-day retention for completed idempotent receipts.
- The six steps are Identity, Model, Access, Delegation, Work source, and
  Review. Identity selects only the existing `auto`, `anthropic_sdk`, or
  `deepagents` agent harnesses. Model selection remains deployment-aware and
  preflight rejects incompatible explicit harness/model/credential choices.
- Access options are lazy safe projections of reviewed capabilities, installed
  skills, active MCP sources, and tools. Delegation selects active same-app
  agents and always states that configured delegation is intended composition,
  not live execution. Empty access and `Configure later` are valid.
- Work source can be configured later, use an existing conversation, or create
  a scheduled job backed by an existing conversation. It never accepts raw
  source configuration, credentials, settings, or provider internals.
- The Control service owns preflight and idempotent staged creation: claim and
  reserve IDs; create or verify the agent; write one fenced desired-state
  revision for name, harness, model, and delegates; apply access; then connect
  the selected work source. Failures leave an unrouted agent plus a resumable
  `needs_attention` draft; retries execute only incomplete stages.
- Browser mutation requests stay same-origin `/ui/api/*`, with the UI server
  retaining the Control credential. The UI API accepts only validated methods,
  JSON content, same-origin requests, bounded body size, and app-safe fields.
  It never returns Control keys, app IDs, raw settings, source definitions,
  storage references, environment requirements, secrets, or internal preflight
  detail.
- The directory presents active/disabled agents alongside Draft, Creating, and
  Needs attention draft rows. Its existing local debounced search includes
  those rows and keeps Enter local: no URL navigation or refetch.

## Acceptance criteria

1. A valid saved draft survives browser/process interruption, is app-isolated,
   reports revision conflicts, and can be deleted only before an agent exists.
2. Creation and resume are idempotent: no retry duplicates an agent,
   conversation install, session, or scheduled job; failure state and safe
   stage receipt remain operator-visible.
3. The modal follows the existing Gantry visual system in light/dark themes,
   keyboard-only use, narrow layouts, and reduced-motion mode; global shared
   components and non-Agent console routes are unchanged.
4. All browser-facing options, drafts, preflight results, and progress are
   explicit safe projections. Control API credentials and excluded
   configuration/secret fields never appear in bundles, requests, responses,
   or UI logs.
5. Contracts, OpenAPI, SDK, repository, creation service, Control API, and UI
   facade coverage prove validation, ownership, revision/lease/replay/recovery,
   retention, safe redaction, and option-cache behavior. The user-visible
   workflow receives a documented manual visual pass; no React component,
   browser automation, snapshot, or visual-regression test suite is added.
