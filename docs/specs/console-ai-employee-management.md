---
slug: console-ai-employee-management
title: Console: onboarding, people, connector accounts, access editing
status: confirmed
saved: 2026-08-26T11:22:26+00:00
---

# Console: onboarding, people, connector accounts, access editing

## Capability

Everything an IT administrator does to an AI employee happens in the console:
onboard it (name, access preset, a channel seat with its secret reference, one
conversation, its approvers) and activate it; see and offboard the people it works
with; add connector accounts and authorise them with one click; and change what it
may touch from its Access tab. The CLI remains available for advanced and
fleet-scripted paths; nothing in the lifecycle *requires* it.

## Why

The tagline is an IT-admin promise and the proof is a browser video. Today the
console's agents and people pages are previews, browser sessions cannot reach
`/v1/*`, a browser cannot create a Gantry-held secret, and connector accounts have
no page at all. Without this capability "onboard" means a terminal session.

## Behaviour

### Onboarding wizard (V1.0)

Screens in order: Employee (name, model alias, access preset `full` default or
`locked`, harness `auto`); Channel seat (provider, label, secret references through
a shared `SecretRefField`, provider validation); Scope (discover or enter a
conversation id, memory scope default `conversation`, trigger); Approvals (one or
more approvers that resolve to Persons); Review and activate — writes happen only on
confirmation and the native identity is verified to respond. Creating the agent
creates its service-kind Person and desired-state entry in one operation. Persona
and profile editing, non-default harness, provider secret rotation, and discovery
beyond a manual id may remain CLI in V1.0 and are labelled as such.

### Secret references

The browser never receives a secret value. A write-only ingest facade stores a
submitted value in the Gantry secret provider and returns only its reference
(decision 0143); existing `env:` and `aws-sm:` references are selected by name.

### People (V1.0)

`/people` and `/people/:id` become live: list, detail, aliases with verification
state, kind. Offboard is administrator-only with hosted re-authentication and an
exact-name confirmation; it calls the person offboard use case and shows the audit
row. Service-kind Persons link to their agent.

### Connector accounts (V1.0.x)

Configure › Connector Accounts, separate from MCP Servers: list and detail with
kind, label, owning agent, external identity, scopes, OAuth status, generated MCP
binding, alias, supervisor health and capacity. Connect starts the OAuth flow and
lands on verified/failed; reauthorize, revoke, retire. Tokens and transport controls
are never shown.

### Access editor (V1.0.x)

The agent's Access tab becomes editable — access document, tool rules, capability
grants, MCP bindings — as desired-state revisions with visible audit rows.

### Facade rules

All surfaces follow decisions 0132/0135: same-origin `/ui/api/*`, viewer read and
administrator (or owner where the roles spec allows) mutation, exact Origin plus
CSRF, hosted re-authentication for high-risk actions, audit, scope classification,
boundary tests. Existing primitives (`PageHeader`, `Panel`, `DataTable`,
`Dialog`/`AlertDialog`, `PageState`) and the `/people` route pattern are reused; no
toast system — inline receipts.

## Acceptance criteria

- **ONBOARD-UI-1** — Onboarding wizard: create agent, seat, scope, approvers
  - Screens: Employee (name, model alias, access preset full|locked default full, harness auto), Channel seat (provider, label, secret references via SecretRefField, provider validation), Scope (discover or enter conversation id, memory scope default conversation, trigger), Approvals (one or more resolvable approvers), Review and activate
  - Facades: POST /ui/api/agents (creates agent + service Person + desired-state entry atomically), /ui/api/provider-accounts, /ui/api/provider-accounts/:id/discover-conversations, /ui/api/agents/:id/conversation-installs, /ui/api/conversations/:id/approvers — administrator, Origin+CSRF, hosted reauth, audit
  - Write-only secret ingest endpoint stores a Gantry-held secret and returns only its reference; the browser never receives a secret value (decision 0143)
  - Persona/profile editing, non-default harness, provider secret rotation, and Slack/Teams discovery beyond manual id may stay CLI in V1.0 and are labelled so
- **PEOPLE-UI-1** — People: live list, detail, offboard
  - /people and /people/:id replaced from preview to live via /ui/api/people list/get (viewer read)
  - Offboard action (administrator, hosted reauth, exact-name confirmation dialog) calls the IDENT-4 use case and shows the audit row
  - Service-kind Persons link to their agent detail; humans show verified/unverified/retired aliases
- **UI-CONN-ACCOUNTS-1** — Connector Accounts page: add, connect OAuth, health, revoke
  - Configure > Connector Accounts: list and detail with kind, label, owning agent, external identity, scopes, OAuth status, generated MCP binding, alias, supervisor health and capacity
  - Connect starts the OAUTH-1 authorization-code flow and lands on a verified/failed status; reauthorize, revoke, retire; tokens and transport controls never shown
  - Facades /ui/api/connector-accounts (GET/POST), /:id (GET/PATCH/DELETE), /:id/oauth/authorize, /:id/revoke; separate from the MCP Servers page
  - Shared SecretRefField component validating env:, gantry-secret:, aws-sm: references
- **ACCESS-UI-1** — Access editor: preset, tool rules, capability grants
  - Access tab becomes editable: replace access document, modify tool rules and capability grants, manage MCP bindings; administrator with hosted reauth, Origin+CSRF, audit
  - Facade wraps GET|PUT /v1/agents/:id/access as /ui/api/agents/:id/access with a safe DTO
  - Every change is a desired-state revision with a visible audit row

## Source

Console UI sweep 2026-08-26 (docs/architecture/ai-employee-v1-gap-analysis.md, Part
2); decisions 0132, 0135, 0142, 0143. Stories: ONBOARD-UI-1, PEOPLE-UI-1, UI-CONN-ACCOUNTS-1, ACCESS-UI-1.
