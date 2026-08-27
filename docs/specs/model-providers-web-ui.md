---
slug: model-providers-web-ui
title: Model Providers web UI
status: confirmed
saved: 2026-08-24T05:04:33+00:00
---

# Model Providers web UI

## Why

Gantry operators can configure model-provider credentials through the
Bearer-only Control API, but the web console currently shows fixture-backed
channel providers. Operators need a safe browser-native place to see which
model providers are configured, understand why one is required, and manage
their credentials without exposing a Control API key or a provider secret.

## Behaviour

- Replace the mixed fixture Provider view with a Model Providers inventory
  derived from the server registry. It shows configured/required status,
  provider name, supported modes, last update metadata, and the effective
  runtime reasons requiring the provider.
- Viewer sessions can read the inventory and provider detail. Administrator
  sessions can set or rotate a credential, disable a configured credential,
  and explicitly verify it. The browser uses same-origin `/ui/api` routes;
  `/v1/*` remains Bearer-only.
- Mutations require canonical Origin, CSRF, and the existing recent
  reauthentication policy. Responses, logs, audit events, and UI state expose
  only redacted metadata and safe verification summaries.
- The Providers nav item moves to Configure. The list supports status filters,
  keyboard-accessible expansion, empty/loading/error states, an Add Provider
  picker, and a nested Manage Provider form. Verification is always an
  explicit action; no background checks are introduced.
- Visual composition follows the approved mock for hierarchy and density, but
  uses Gantry routes, data, copy, and navigation. The mock's hard-coded
  provider data, workspace switcher, and Activity placeholder are not shipped.
- Static artwork lives under `apps/web/src/assets/`, grouped by purpose and
  imported through source modules. Do not add inline SVG markup, `<symbol>`,
  or data-URI assets to UI code. Generic UI icons continue to use the existing
  icon library; provider visuals use an asset manifest with an accessible
  monogram fallback.

## Non-goals

- No custom providers, provider deletion, credential profiles, provider search,
  background health monitoring, or historical Activity links.
- No migration and no change to the existing Bearer-only `/v1` credential
  clients beyond an optional safe verification endpoint.

## Acceptance criteria

- The inventory, modes, and required-by reasons are server-derived; no fixture
  provider/channel data or hard-coded credential status ships on the route.
- Browser sessions and Bearer credentials remain mutually rejected. Viewers
  cannot mutate; Administrators can only mutate with Origin, CSRF, and recent
  reauthentication checks.
- Credential input is write-only. Browser payloads never contain provider
  secrets, Control API keys, tokens, or raw verification responses.
- Unknown provider IDs fail closed. A failed verification leaves the active
  credential unchanged and returns safe, actionable feedback.
- The UI is keyboard-accessible and keeps provider artwork as separately
  imported source assets. Decorative visuals are hidden from assistive
  technology; icon-only controls have accessible names.
- Existing credential API tests remain valid, focused server/UI tests cover the
  new authorization and redaction paths, and final factory verification runs.
