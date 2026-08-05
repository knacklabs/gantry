---
decisions_reviewed:
  - 0000
  - 0001
  - 0002
  - 0003
  - 0004
  - 0005
  - 0006
  - 0007
  - 0008
  - 0009
  - 0010
  - 0011
  - 0012
  - 0013
  - 0014
  - 0015
  - 0016
  - 0017
  - 0018
  - 0019
  - 0020
  - 0021
  - 0022
  - 0023
  - 0024
  - 0025
  - 0027
  - 0028
  - 0029
  - 0030
  - 0031
  - 0032
  - 0033
  - 0034
  - 0035
  - 0040
  - 0041
  - 0042
  - 0043
  - 0044
  - 0045
  - 0046
  - 0050
  - 0051
  - 0052
  - 0053
  - 0054
  - 0055
  - 0056
  - 0057
  - 0058
  - 0062
  - 0063
  - 0064
  - 0065
  - 0066
  - 0067
  - 0068
  - 0069
  - 0070
  - 0071
  - 0072
  - 0073
  - 0074
  - 0075
  - 0076
  - 0077
  - 0078
  - 0079
  - 0080
  - 0081
  - 0082
  - 0083
  - 0084
  - 0085
  - 0086
  - 0087
  - 0088
  - 0089
  - 0090
  - 0091
  - 0092
  - 0093
  - 0094
  - 0095
  - 0096
  - 0097
  - 0098
  - 0099
  - 0100
  - 0101
  - 0102
  - 0103
  - 0104
  - 0105
  - 0106
  - 0107
  - 0108
  - 0109
---

# GANTRY-WEB-FOUNDATION — Safe Web UI foundation shell

## Problem

Gantry has no independently validated web UI starting point. The existing UI
work also includes runtime delivery and administration changes, so it cannot
be merged safely into the hosted runtime as a foundation.

## Scope / Non-goals

In scope: a source-only `apps/web` Vite/React workspace, `/ui` client base
path, responsive shell, disconnected placeholder, browser-only preferences,
web-only commands and CI steps, and a boundary document.

Out of scope: runtime serving or `/ui-api`, authentication, environment
variables, Docker or package contents, API/SDK/contracts, providers, agents,
identity, persistence, migrations, and all product consoles. The existing
full UI branch and identity stash remain untouched.

## Acceptance Criteria

1. `apps/web` independently builds under `/ui` and displays an accessible,
   responsive `Not connected` shell with local preferences.
2. Separate root commands and CI steps run web formatting, typechecking,
   linting, and building.
3. `npm run build:web` creates `apps/web/dist`; normal `npm run build` does
   not create or copy `dist/ui` and production delivery remains unchanged.
4. Documentation states that the workspace has no runtime connection and
   requires a later approved integration PR before it can be served.

## Technical Approach

Extract only the disconnected shell from the prior UI foundation commit. Keep
the existing Vite, React, TanStack router, local preference, typography, icon,
and accessible mobile-navigation patterns when they are actually imported;
remove all data, API, and product-screen code. Add `apps/web` to the current
root manifest without changing existing build, runtime, package, or delivery
scripts. Add three dedicated web validation steps to the existing CI job and
write a narrow architecture boundary document.

The simpler shape is one static document and one disconnected route rather
than a local server, mock API, or feature flags. Those mechanisms have no
consumer in this PR and would violate the source-only boundary.

## Decisions

No new decisions. This implementation follows the approved source-only scope,
including the early-stage no-backcompat and deployment-boundary decisions.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Unchanged by design | No runtime imports, routes, environment variables, or serving changes. |
| API | Unchanged by design | No Control API, contract, SDK, or `/ui-api` work. |
| Data/schema | Unchanged by design | No repositories, schema, or migrations. |
| CLI/ops | Unchanged by design | Normal runtime build, Docker, publishing, and deployment stay unchanged. |
| UI | Changed | Adds a disconnected source-only shell and local browser preferences. |
| Docs | Changed | Records the source-only boundary and deferred integration seam. |
| Tests | Changed | CI and deterministic web workspace checks are added; existing runtime lanes remain unchanged. |

## Task Decomposition

**GANTRY-WEB-FOUNDATION-1 — disconnected shell and validation seam.**
Write scope: `apps/web/**`, root `package.json`, `package-lock.json`,
`.github/workflows/ci.yml`, `docs/architecture/web-ui-foundation.md`, and
Factory planning artifacts. This one bounded slice directly satisfies all four
acceptance criteria: it adds the only route, validates it separately, and
keeps production delivery untouched.

## Risks

- A root manifest merge could accidentally modify a production build command.
  Compare the final manifest and run the normal build to prove it did not.
- A Vite base path can be incorrectly assumed to imply server hosting. Search
  for server `/ui` and `/ui-api` routes and document the distinction.
- The shell can accrue unused dependencies. Audit imports before regenerating
  the Node 24 lockfile.

## Verify Plan

Run `npm ci`, `npm run typecheck:web`, `npm run lint:web`, `npm run build:web`,
`npm run format:check`, `npm run typecheck`, `npm run test:unit`,
`npm run test:integration`, `npm run build`, `python3 scripts/check_architecture.py`,
and `python3 factory/scripts/verify.py` with Node 24. Confirm `apps/web/dist`
exists only after `build:web`; inspect the normal build for no `dist/ui`; use
the requested cleanup search and verify the diff excludes `apps/core`,
contracts, SDK, migrations, and Docker.
