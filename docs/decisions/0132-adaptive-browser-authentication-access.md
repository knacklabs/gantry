---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-18
stories: [WEB-AUTH-1]
---

# Browser authentication and console access

## Context

Gantry's Control API deliberately uses machine Bearer credentials. The web
console needs a different, revocable browser trust path without ever exposing
an API key, OIDC token, provider claim, or runtime secret to browser code.
Decision 0101 already fixes generic OIDC, Google first, and issuer-plus-subject
identity. The approved Authentication & Access design supplies the remaining
local bootstrap, access, session, recovery, and UI rules.

## Decision

Confirmed by Ravi in the approved WEB-AUTH-1 design, 2026-08-18:

1. Browser authentication is an independent local-or-hosted setting. Local
   authorization is loopback-only and begins with a trusted CLI-created,
   ten-minute, one-use, hash-only fragment token. Hosted authentication is
   generic authorization-code OIDC with PKCE, Google first, canonical-origin
   redirects, and server-side provider validation.
2. A browser receives only an opaque, hashed, revocable session cookie. Browser
   routes reject Bearer credentials; `/v1/*` remains Bearer-only and rejects
   session cookies. Every browser mutation requires exact canonical Origin and
   synchronizer CSRF validation.
3. Identity stays Person plus aliases. OIDC aliases are trusted verified
   `oidc/<issuer>/<sub>` records; a verified normalized email alias may consume
   an invitation but never selects or links a Person by itself.
4. Console access is exactly `Administrator` or `Viewer`; console roles do not
   change conversation approval. The final active Administrator cannot be
   disabled or demoted. Domain-matching hosted identities receive Viewer;
   everyone else needs an invitation or trusted CLI approval.
5. Local sessions last 30 days idle / 90 days absolute. Hosted sessions last
   two hours idle / 12 hours absolute and warn five minutes before absolute
   expiry. Reauthentication is required within ten minutes for high-risk work;
   it never replays a pending mutation. Session IDs rotate after login,
   reauthentication, and role elevation.
6. Access setup is candidate/test/activate through settings revisions. Client
   secrets resolve only through `RuntimeSecretProvider`. First or lost
   administrator recovery is the confirmed CLI flow `gantry auth access
   approve <reference> --role administrator|viewer`; there is no public
   recovery route, emailed invitation, custom role, or compatibility path.

## Consequences

- The Control server owns same-origin `/ui`, `/auth/*`, and browser facade
  routes only in its full profile; operational worker profiles do not mount
  them. Authentication and cookie responses are `no-store`, rate limited, and
  audit only safe classifications.
- OIDC transactions retain an encrypted short-lived PKCE verifier so callback
  processing can recover it; all reusable tokens and references are stored as
  hashes and atomically consumed. The implementation uses the existing
  DNS-pinned outbound transport and `jose` for signature validation.
- The browser facade maps every Control scope to Administrator, Viewer-safe
  read, or browser-ineligible. Unclassified or unrelated fixture-backed
  surfaces remain default-deny until explicitly classified.
- Documentation must cover local use, hosted proxy/cache requirements, setup,
  first-admin approval, lost-admin recovery, and broken-OIDC recovery. The
  external approved design at
  `/Users/caw/Desktop/2026-08-18-authentication-access-web-ui-design.md`
  defines the exact user-facing copy and remaining detailed acceptance rules.
