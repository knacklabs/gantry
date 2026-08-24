# Local browser reauthorization

## Goal

Make expired or near-expiry local browser access understandable and recoverable
without ever allowing an unauthenticated browser to mint administrator access.

## Scope

- When a local browser session has one minute remaining, show a persistent
  "Reauthorize this browser" action.
- The action calls the existing authenticated, CSRF-protected
  `POST /ui/api/auth/local/authorize` endpoint and replaces the current tab
  with its returned one-time authorization URL.
- When a protected browser request returns `401`, send a local-mode user to a
  local reauthorization screen. Hosted users retain the existing OIDC
  reauthentication path.
- When no valid session remains, the local screen explains that the user must
  run `gantry ui authorize`; it must not offer a regeneration button.
- Replace the local-mode unauthenticated fallback that currently renders the
  Google sign-in page with the local guidance screen.

## Design

The browser session bootstrap response includes the authentication mode. The
root app uses it to choose the correct reauthorization UI while preserving the
existing hosted behavior.

The local banner and reauthorization screen share a small action that reads the
CSRF cookie, requests a new URL from the existing endpoint, and navigates the
same tab to that URL. The endpoint already requires a valid local session,
canonical origin, and CSRF token, so it remains the sole server authority for
creating authorization codes.

A centralized browser request helper handles `401` responses. It routes to
local reauthorization only when the client knows the current session was local;
otherwise it leaves the existing hosted route intact. Individual feature pages,
including Model providers, do not add their own expiry logic.

## Security and failure handling

- Do not add an unauthenticated endpoint that generates local authorization
  links. Loopback alone is not sufficient proof of local administrator intent.
- Never put the one-time token in application state, logs, or query strings;
  retain the existing URL-fragment handoff.
- If the regeneration request fails, show a safe retry message and leave the
  current session untouched.
- A fully expired local session can only display the CLI instruction.

## Verification

- Focused unit coverage proves local/hosted routing decisions and that the
  reauthorization action uses the existing endpoint.
- Browser check: authorize locally, confirm the one-minute action opens the
  local authorization flow in the same tab, then confirm Model providers
  reloads with an authenticated inventory request.
- Confirm an unauthenticated local deep link shows CLI guidance, not Google,
  and does not expose a regeneration action.
