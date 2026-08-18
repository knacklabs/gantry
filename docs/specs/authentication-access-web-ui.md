---
slug: authentication-access-web-ui
title: Authentication and Access Web UI
status: draft
saved: 2026-08-18T10:42:43+00:00
---

# Authentication and Access Web UI

## Why

Gantry has machine API-key authentication but no safe browser authentication.
Operators need a revocable browser session for local installations and
company deployments without exposing Control API credentials, OIDC tokens, or
runtime secrets to the browser.

This specification implements the approved design in
`/Users/caw/Desktop/2026-08-18-authentication-access-web-ui-design.md` as the
in-repository WEB-AUTH-1 source of truth.

## Behaviour

- Local deployments issue a ten-minute, single-use browser authorization URL
  from the trusted CLI. The token stays in the URL fragment, is stored only as
  a hash, and creates a 30-day idle / 90-day absolute server session.
- Hosted deployments use generic OIDC authorization-code flow with PKCE. Google
  Workspace is the first configuration. Identity is issuer plus subject; email
  is verified contact data only.
- Hosted sessions are opaque, revocable, two-hour idle / 12-hour absolute,
  use HttpOnly same-origin cookies, and require reauthentication within ten
  minutes for high-risk access and OIDC-configuration changes.
- The only console roles are Administrator and Viewer. Browser routes enforce
  those roles directly; existing `/v1/*` Bearer clients retain their current
  API-key contract and never accept browser cookies.
- Administrators can manage console access, one-time seven-day invitations,
  browser sessions, and staged OIDC configuration. The final active
  Administrator cannot be disabled or demoted.
- Trusted infrastructure operators recover first or lost administrator access
  only through `gantry auth access approve`; there is no public recovery route,
  recovery session, or raw-SQL workflow.

## Acceptance criteria

- Local authorization rejects non-loopback use, expires after ten minutes, is
  atomic and single-use, and never exposes the raw bootstrap token after use.
- Hosted sign-in validates discovery, allowlisted issuer, state, nonce, PKCE,
  signature, audience, and expiry; no-access identities do not gain access.
- OIDC identities are durable `(issuer, sub)` aliases; verified email matching
  can consume an invitation but never identifies the Person on its own.
- Browser cookies and Bearer credentials are mutually rejected across browser
  and `/v1/*` routes. Mutations require canonical Origin and CSRF validation.
- Sessions, grants, invitations, configuration changes, and CLI approvals
  produce secret-free audit events and are immediately subject to current
  access status.
- Browser responses, storage, logs, events, fixtures, and snapshots do not
  contain Control API keys, OIDC tokens, client secrets, raw claims, or any
  reusable bootstrap/session/invitation token.
- The web UI presents the approved local/hosted Authentication & Access
  screens, exact user-facing copy, keyboard behavior, themes, and reduced
  motion without converting unrelated fixture-backed console pages to live
  APIs.
