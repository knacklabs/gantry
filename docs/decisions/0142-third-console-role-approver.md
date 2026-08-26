---
status: proposed
confirmed_by: ""
date: 2026-08-26
stories: [RBAC-1, DIR-UI-1, ONBOARD-UI-1]
---

# Third console role: approver (amends 0132)

## Context

Decision 0132 fixes the browser console at two roles, administrator and viewer,
and the client, session model, scope policy, and CLI all encode that pair. The
confirmed spec `approvals-and-roles` requires a third role, `approver`, that can
resolve approvals routed to the console (when that surface exists) and assign
approvals for agents it owns, without administering the deployment. Roles must
bind to `PrincipalRef` so a service-kind Person can hold one later.

## Decision

The console role set becomes administrator, approver, viewer. `approver` is
browser-eligible for approval-resolution scopes only when a console approval
surface ships; in V1.0 it is a grant-editor and CLI role with no risky-action
authority (risky approvals stay API-key or channel scoped). Role bindings are
stored against `PrincipalRef`. `BrowserSession`, `isBrowserRole`, the scope
policy classification, the access grant editor, and `gantry auth access
approve` are widened together. Everything else in 0132 stands.

## Consequences

- Viewer auto-grant is generalised per issuer (Google `hd`, Entra `tid`); higher
  roles remain explicit.
- The final-active-administrator protection is unchanged.
- Adding further roles or custom roles requires a new decision.
