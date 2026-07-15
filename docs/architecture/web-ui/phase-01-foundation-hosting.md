# Phase 1: Foundation And Hosting

## Goal

Create `apps/web` and host it at `/ui`. This phase owns local pairing only, not
user accounts, OAuth, or SSO. It ships shared UI states, not operational data
screens.

## Dependencies And Exclusions

Dependencies: current Control API, contracts, `runtime_events`, and static
asset packaging. Excluded: operator screens, identity accounts, OAuth/OIDC,
SAML, and non-loopback UI hosting.

## Screens

| Screen        | Required behavior                                                                     |
| ------------- | ------------------------------------------------------------------------------------- |
| Local pairing | One short-lived code field; clear expiry/error state; success enters the shell.       |
| App shell     | Sidebar, mobile drawer, header, theme control, connection state, stable content area. |
| Shared states | Loading, empty, error, offline, reconnecting, and safe read retry.                    |
| Profile       | Theme and browser preferences only; no identity fields.                               |

## Steps

1. Add Vite/React workspace, router, tokens, primitives, shared compositions,
   and untracked `dist` output. Do not add a frontend test harness or testing
   dependencies in this phase.
2. Build and serve the SPA under `/ui` with UI-only history fallback; Vite uses
   `5173` and proxies `/v1` to loopback Control API `3939`.
3. Add browser-safe pairing/session/error/event contracts; browser never imports
   the Node SDK.
4. Add hashed pairing and session persistence, expiry/revocation, `HttpOnly`
   `SameSite=Strict` cookie, CSRF, origin/host checks, audit, and `gantry ui pair`.
5. Add app-scoped `GET /v1/events` JSON/SSE replay over `runtime_events`; one
   coordinator invalidates snapshots and never issues commands.

## Acceptance And Checks

- Direct `/ui` refresh, expiry/logout, invalid CSRF/origin, SSE reconnect and
  cursor replay work; no secret or API key appears in browser storage.
- Shell works at 1440px, 1024px, and 390px in both themes.

```bash
npm run test:unit -- apps/core/test/unit/control/ui-auth-routes.test.ts apps/core/test/unit/application/ui-session-service.test.ts apps/core/test/unit/application/runtime-events/runtime-event-exchange.test.ts
GANTRY_TEST_DATABASE_URL=<disposable-url> npm run test:integration:postgres
npm run test:unit --workspace @gantry/web -- src/lib/auth src/lib/events
npm run test:e2e --workspace @gantry/web -- tests/e2e/foundation.spec.ts
rg -n -e 'localStorage' -e 'sessionStorage' -e 'GANTRY_CONTROL_API' -e 'Bearer ' -e 'dist/ui' apps/web apps/core/src packages --glob '!**/dist/**'
```

Only theme preference storage is acceptable in cleanup results; bearer secrets
and tracked UI output are not.

## Surface Impact And Handoff

| Surface                                                              | Status              | Reason                                                                  |
| -------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------- |
| Runtime, settings, Postgres, API, contracts, CLI, audit, tests, docs | Changed             | Add hosting, local pairing, SSE, contracts, verification, and guidance. |
| MCP/admin, providers                                                 | Unchanged by design | UI does not grant authority; adapters retain transport.                 |

Phase 2 starts after pairing, typed REST, SSE replay, and shared compositions
are stable.
