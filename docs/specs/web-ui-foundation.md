---
slug: web-ui-foundation
title: Source-only web UI foundation
status: confirmed
saved: 2026-08-05T09:30:00+00:00
---

# Web UI foundation

## Capability

Gantry includes a standalone, buildable React workspace that establishes the
visual and routing foundation for a future operator UI without changing or
connecting to the hosted runtime.

## Behaviour (acceptance)

1. `apps/web` builds independently under the `/ui` base path and renders a
   responsive, accessible application shell with neutral navigation, local
   browser preferences, and a clear `Not connected` state.
2. Root workspace commands and pull-request CI validate web formatting,
   typechecking, linting, and building independently from the production
   runtime build.
3. `npm run build:web` produces `apps/web/dist`; the normal `npm run build`
   does not build, copy, package, or serve web assets.
4. The production runtime, Control API, authentication, providers, storage,
   SDK/contracts, CLI, Docker images, publishing, and deployment interfaces
   are unchanged.
5. Architecture documentation states that this workspace is source-only and
   requires a separately approved integration before any runtime can serve or
   connect it.

## Non-goals

Runtime `/ui` hosting, a `/ui-api` bridge, authentication, environment
variables, Docker packaging, API clients, database changes, agent or identity
administration, and preview product screens.

## Constraints

- Start from freshly fetched `upstream/main` in an isolated worktree.
- Reuse only the disconnected shell portion of the existing UI work.
- Keep the existing production build and delivery workflows unchanged.
- Keep the existing full UI branch, draft PR, and identity stash unchanged.
