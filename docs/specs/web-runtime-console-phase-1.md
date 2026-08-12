---
slug: web-runtime-console-phase-1
title: Web Runtime Console — Phase 1: Connection Foundation
status: confirmed
saved: 2026-08-12T00:00:00+00:00
---

# Web Runtime Console — Phase 1: Connection Foundation

## Goal

Make the existing Gantry web UI a private/local, read-only client of one
Gantry deployment. A browser can see whether the Control API is reachable and
can view that deployment's real agents without receiving a Control API key.

## Scope

- Serve the built React UI at `/ui` with deep-route fallback.
- Add `GET /ui/api/connection`, backed by the existing authenticated
  `GET /v1/health` Control API route.
- Add `GET /ui/api/agents`, backed by the existing authenticated
  `GET /v1/agents` Control API route.
- Replace fixture data on the Overview and Agents pages with real responses.
- Render loading, empty, stale, disconnected, retry, and partial-panel states
  using existing UI primitives.
- Preserve the existing visual system and replace the production navigation
  with the approved Phase 1 subset: Overview and Agents.

## Non-goals

- OIDC, login, roles, public/network deployment, or more than one deployment.
- Metrics, instance inventory, agent detail relationships, live activity, SSE,
  mutations, restarts, or agent creation.
- A new client-side API library, direct Postgres access, browser-held Control
  API credentials, fixture fallback, or new UI dependencies.
- Frontend unit/component/E2E/snapshot/visual-regression tests. The repository
  required functional check remains a single manual-style acceptance pass.

## Acceptance Criteria

1. A built artifact serves `/ui` and a deep `/ui/...` route.
2. `/ui/api/connection` and `/ui/api/agents` use server-held credentials and
   expose only safe read models from the current deployment.
3. Overview and Agents render live data, a clear loading state, an explicit
   empty state, and a disconnected/retry state; they never present fixtures or
   fabricated zero values as runtime data.
4. A failed refresh preserves the last successful value and marks it stale.
5. UI polling is visible-only, bounded to the approved cadence, backs off to
   five minutes after failures, and deduplicates manual refreshes.
6. The UI remains responsive, keyboard accessible, reduced-motion safe, and
   uses short opacity/color transitions only where they communicate state.

## Source Design

The full approved design, phase sequence, API extensions, retention boundary,
and later scope are in
`docs/superpowers/specs/2026-08-12-web-runtime-console-design.md`.
