---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-01
stories: [ID-1]
---
# UI login is generic OIDC; Google is the first configured issuer

## Context

The future UI needs auth-provider login, and Ravi wants the provider list OPEN — "add any
in the future like Google Workspace or Microsoft". The identity model (ID-1 / spec
person-identity-aliases) already keys OIDC aliases on issuer + sub, so nothing forces a
provider-specific implementation. A bespoke "Sign in with Google" would make every later
provider its own project; a generic layer makes each one a config row.

## Decision

Confirmed by Ravi in chat, 2026-08-01:

1. Implement LOGIN AS GENERIC OIDC: standard discovery (/.well-known/openid-configuration),
   authorization-code flow with PKCE, issuer allowlist in configuration. Adding a provider
   is adding an issuer, never new integration code.
2. GOOGLE IS THE FIRST CONFIGURED ISSUER. Rationale: the org already lives on Google; the
   approved connector strategy (direct OAuth, org-owned GitHub+Google v1) shares the same
   Google Cloud OAuth console and credential handling; one issuer covers BOTH user types
   (Workspace = org employees, plain Gmail = application users).
3. THE `hd` CLAIM DRIVES THE EMPLOYEE DERIVATION for Google Workspace: hd matching the org
   domain on a verified oidc alias = employee (per the no-user-type-column decision in the
   ID-1 plan). A Google login without hd is an application user.
4. Microsoft Entra (or any other IdP) is added WHEN A CUSTOMER ASKS, as configuration.
   Entra's per-tenant issuer URLs get validated by the same generic issuer allowlist.

5. FIRST LOGIN: an account whose `hd` matches the org domain auto-creates the person
   (the IdP asserted them); any other account authenticates into a no-access state until
   an admin invites/approves. Open self-registration stays closed.
6. V1 AUDIENCE: the UI login is for admins and org employees only. Application users keep
   arriving via channels/SDK and never see this UI; an end-user portal is its own later unit.
7. SESSION: after the code flow, the control server issues its OWN short-lived revocable
   session (httpOnly cookie, server-side record). IdP tokens are verified once and never
   stored client-side.
8. APP SCOPING: v1 HARDCODES app `default` (Ravi's call, against the app-picker
   recommendation — accepted rework: the session shape must gain a selected-app field when
   a second app exists).

## Consequences

- The login handler must never use the `email` claim as an identifier, even with
  email_verified=true — Google recycles abandoned addresses. Identity keys on issuer+sub
  (ID-1 decision 3); the email travels as a separate, normalised contact alias.
- OIDC logins are a system-attested verification flow: a completed code-flow login proves
  control of the subject, so the resulting alias may be marked verified (ID-1 decision 7).
- No change to ID-1's scope: the current work stays issuer-agnostic; this decision shapes
  the future UI/login unit only.
- Deferred: session lifetime, refresh handling and the login UI itself belong to the UI
  unit that implements this, not to this record.
