# Gantry Web UI Delivery Phases

These documents expand the parent [Gantry Web UI Implementation Plan](../gantry-web-ui-implementation-plan.md)
into independently deliverable handoffs. The parent plan owns shared
architecture and decisions; phase documents may add delivery detail but must
not contradict it.

## Order

1. [Foundation and hosting](./phase-01-foundation-hosting.md)
2. [Operations console](./phase-02-operations-console.md)
3. [Agent administration](./phase-03-agent-administration.md)
4. [Chat and rich interactions](./phase-04-chat-rich-interactions.md)
5. [Jobs, runtime, and activity](./phase-05-jobs-runtime-activity.md)
6. [People](./phase-06-people.md)
7. [Workflows](./phase-07-workflows.md)
8. [Hardening and release](./phase-08-hardening-release.md)

## Shared Rules

- `apps/web` is a React application built separately and served by the existing
  Gantry process at `/ui`; Vite development proxies `/v1` to Control API.
- REST is command and snapshot authority. HTTP SSE is durable observation with
  cursor replay. Browser WebSockets are excluded.
- React consumes canonical contracts only. Provider Socket Mode/webhooks remain
  server-side channel adapter concerns.
- One-time, loopback-only pairing is the Phase 1 browser boundary. It is not an
  account system. Identity, OAuth/OIDC, SAML, SSO, roles, and non-loopback UI
  exposure are deferred.
- Desired-state writes use `SettingsDesiredStateService`, revision concurrency,
  projection reconciliation, and `settings.yaml` synchronization.
- Automated UI testing is deferred. The test commands listed in individual
  phase documents are future scope only and must not be added, run, or reported
  as evidence until the user explicitly approves test work. Current phase
  evidence is manual acceptance, cleanup searches, builds, and structural gates.

## Route Ownership

| Route group                                                      | Phase |
| ---------------------------------------------------------------- | ----- |
| `/ui`, `/profile`                                                | 1     |
| `/overview`, `/providers`, `/conversations/:id?`, `/diagnostics` | 2     |
| `/agents/:id?`                                                   | 3     |
| `/chat/:sessionId`                                               | 4     |
| `/jobs/:id?`, `/activity`, `/runtime/*`                          | 5     |
| `/people/:id?`                                                   | 6     |
| `/workflows/:id?`                                                | 7     |

Every route includes loading, empty, partial-data, error, stale, reconnecting,
and offline states. Below 900px inspectors become drawers or routed detail;
below 640px navigation becomes a drawer and tables expose compact detail.
