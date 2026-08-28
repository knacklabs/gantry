---
slug: approvals-and-roles
title: Approvals by principals and console roles
status: confirmed
saved: 2026-08-27T07:38:52+00:00
---



# Approvals by principals and console roles

## Capability

A human approves an agent's risky action where the team already works — in the
channel for group conversations, in the DM for their own — and the record names the
approver as a person, not a provider id. The web console signs users in with the org's
identity provider (Google or Entra ID) and offers three roles: administrator, approver,
viewer. Every agent has an owner.

## Why

Regulated buyers need approvals attributed to a person and console roles that match the org's identity provider. Today approvers are raw provider ids and the console has two roles and Google-only auto-grant.

## Behaviour

### Approval authority

- Per-conversation model unchanged: `control_approvers` on a conversation approve in
  that conversation; in a direct conversation the resolved Person self-approves
  (already the behaviour; kept as regression proof).
- Approvers are `PrincipalRef`s. `conversation_approvers.external_user_id` migrates to
  alias-resolved Persons; an unresolvable id fails the migration (no silent drop, no
  raw-id fallback).
- Existing Slack, Teams, and Discord cards and the durable claim/resolve decision path
  are reused; no new cards, no parallel decision store. Approval outcomes are audited
  with the approver's `PrincipalRef`.
- Browser-console approvals are out of scope for V1.0: the API route stays
  `approvals:write` key-scoped and stamps the key as a `system` actor. A console
  approval inbox is a later capability and must pass the same `canApprove` check.
- Shared authority/callback files are also touched by the active permission-engine
  work (PERM-2); this capability serializes behind it or jointly owns those files.

#### Approver lifecycle

Approvals expire after a configured time with a reminder and escalation to the
owner; expiry is a denial, audited. Offboarding the last owner or approver of an
agent pauses it and notifies administrators until a replacement is assigned.

## Console roles

- Sign-in is generic OIDC (decision 0101). Entra ID is a configured issuer beside
  Google. Per-issuer grant policy: a configured tenant/domain claim (Google `hd`,
  Entra `tid`) auto-grants viewer; higher roles are assigned explicitly.
- Roles: administrator (everything), approver (may resolve approvals routed to the
  console when that surface exists; may not administer), viewer (read). Role bindings
  attach to `PrincipalRef`, so a service-kind Person can hold a role later.
- Agent owner: a `PrincipalRef` relation on the agent. Owner may pause/resume the agent
  (explicit agent state, distinct from `disabled`) and assign its approvers. Offboard
  stays administrator-only.
- Browser-scope policy, auth routes, and web role unions carry the third role; no
  browser session ever receives a Control API credential.

## Acceptance criteria

- **HITL-1** — In-chat approvals as principals
  - Approvers are PrincipalRefs; conversation_approvers.external_user_id migrates to alias-resolved principals on IDENT-2 and fails migration if unresolvable
  - Per-conversation model unchanged: channel approvers approve in channels; DM self-approval (already present) covered by regression tests
  - Existing Slack/Teams/Discord cards and the durable claim/resolve path reused; no new cards, no parallel decision store
  - Browser-console approvals are out of scope for V1.0 (API route stays key-scoped); shared authority/callback files serialized with PERM-2
  - Approval outcomes audited with the approver's PrincipalRef (via AUDIT-1)
  - Approvals expire after a configured time with a reminder to approvers and escalation to the owner via ADMIN-ALERT-1; an expired approval is a denial, audited
- **RBAC-1** — Roles for people and agents
  - Entra ID OIDC login for the console beside existing Google OIDC
  - Third role 'approver': can approve, cannot administer
  - Each agent has an owning principal; owner can pause/resume and assign approvers; offboard stays administrator-only
  - Roles apply to PrincipalRef of either kind
  - Agent owner is a PrincipalRef relation; pause/resume is an explicit agent state with owner authorization; offboard requires agents:admin
  - Role bindings stored on PrincipalRef; browser-scope policy, auth routes, and web role unions updated for the third role
  - Entra sign-in is generic OIDC config; Viewer auto-grant generalised beyond Google hd claim or replaced by invitation/CLI approval
  - Authentication & Access page: issuer collection with Entra beside Google, per-issuer tenant/domain auto-grant policy (Google hd, Entra tid), test/activate lifecycle per issuer, sign-in page issuer picker
  - Grant editor and CLI gantry auth access approve accept role approver; BrowserSession/isBrowserRole/web role unions widened
  - Decision 0132 amended for the third role (decision 0142) before implementation
  - Offboarding the last owner or last approver of an agent pauses the agent (INCIDENT-1 state) and notifies administrators; the agent cannot resume until a replacement is assigned
  - Entra app registration and tenant-admin consent steps documented for the customer's Teams/Entra administrator

## Source

Grill 2026-08-26 (Q5, Q11, Q12, Q15, Q27) and spec round (Entra grant policy); gap
sweep (approvals/RBAC). Stories: HITL-1, RBAC-1.
