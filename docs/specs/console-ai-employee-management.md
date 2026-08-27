---
slug: console-ai-employee-management
title: Console: onboarding, people, connector accounts, access editing
status: confirmed
saved: 2026-08-27T07:38:52+00:00
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

### Directory and People (V1.0)

There is one Directory: people and AI employees in a single list with a kind
filter (People | AI employees), search, and URL state; the `/agents` and `/people`
previews are replaced. Audit and Approvals tabs render only for administrators
and approvers; viewers see Overview and Access. Person detail shows aliases with
verification state and kind. Offboard is administrator-only with hosted re-authentication and an
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

### Handoffs view (V1.0.x)

A read-only Handoffs view (open, claimed, resumed; who and when) for
administrators and approvers; claiming stays in Teams/Slack, consistent with no
console approval authority in V1.

### Design pass first

DESIGN-1 produces one approved mockup canvas — Directory, agent and person
detail, onboarding wizard, Handoffs, offboard confirmation, light and dark — in
the console's existing design system. DIR-UI-1 and ONBOARD-UI-1 are planned from
those mockups plus this spec.

### Accessibility

All console surfaces meet WCAG 2.1 AA: keyboard operable, labelled controls,
contrast, 200% zoom, screen-reader names on actions.

### Facade rules

All surfaces follow decisions 0132/0135: same-origin `/ui/api/*`, viewer read and
administrator (or owner where the roles spec allows) mutation, exact Origin plus
CSRF, hosted re-authentication for high-risk actions, audit, scope classification,
boundary tests. Existing primitives (`PageHeader`, `Panel`, `DataTable`,
`Dialog`/`AlertDialog`, `PageState`) and the `/people` route pattern are reused; no
toast system — inline receipts.

## Acceptance criteria

- **DESIGN-1** — Console design pass: directory, detail, wizard, people, handoffs
  - One design canvas with: unified Directory list (kind filter People | AI employees), agent detail with tabs (Overview, Access, Audit, Approvals, Usage), person detail, onboarding wizard screens, Handoffs view, offboard confirmation; light and dark
  - Uses existing console primitives and tokens; no new component library
  - Approved by the product owner before DIR-UI-1 and ONBOARD-UI-1 are planned; mockups linked from their plans
  - APPROVED 2026-08-26 by vrknetha — canvas https://claude.ai/code/artifact/cbcf11f1-8bc2-4912-bb37-b2ea7c300010 (21 artboards, light/dark). DIR-UI-1 and ONBOARD-UI-1 plan from these mockups.
- **ONBOARD-UI-1** — Onboarding wizard: create agent, seat, scope, approvers
  - Screens: Employee (name, model alias, access preset full|locked default full, harness auto), Channel seat (provider, label, secret references via SecretRefField, provider validation), Scope (discover or enter conversation id, memory scope default conversation, trigger), Approvals (one or more resolvable approvers), Review and activate
  - Facades: POST /ui/api/agents (creates agent + service Person + desired-state entry atomically), /ui/api/provider-accounts, /ui/api/provider-accounts/:id/discover-conversations, /ui/api/agents/:id/conversation-installs, /ui/api/conversations/:id/approvers — administrator, Origin+CSRF, hosted reauth, audit
  - Write-only secret ingest endpoint stores a Gantry-held secret and returns only its reference; the browser never receives a secret value (decision 0143)
  - Persona/profile editing, non-default harness, provider secret rotation, and Slack/Teams discovery beyond manual id may stay CLI in V1.0 and are labelled so
  - WCAG 2.1 AA: keyboard operable, labelled controls, contrast, zoom to 200%, screen-reader names on actions
- **PEOPLE-UI-1** — People in the Directory: detail, aliases, offboard
  - People appear in the unified Directory (kind = People) via /ui/api/people; person detail replaces the /people/:id preview
  - Offboard action (administrator, hosted reauth, exact-name confirmation dialog) calls the IDENT-4 use case and shows the audit row
  - Service-kind Persons link to their agent detail; humans show verified/unverified/retired aliases
  - WCAG 2.1 AA: keyboard operable, labelled controls, contrast, zoom to 200%, screen-reader names on actions
- **UI-CONN-ACCOUNTS-1** — Connector Accounts page: add, connect OAuth, health, revoke
  - Configure > Connector Accounts: list and detail with kind, label, owning agent, external identity, scopes, OAuth status, generated MCP binding, alias, supervisor health and capacity
  - Connect starts the OAUTH-1 authorization-code flow and lands on a verified/failed status; reauthorize, revoke, retire; tokens and transport controls never shown
  - Facades /ui/api/connector-accounts (GET/POST), /:id (GET/PATCH/DELETE), /:id/oauth/authorize, /:id/revoke; separate from the MCP Servers page
  - Shared SecretRefField component validating env:, gantry-secret:, aws-sm: references
  - WCAG 2.1 AA: keyboard operable, labelled controls, contrast, zoom to 200%, screen-reader names on actions
- **ACCESS-UI-1** — Access editor: preset, tool rules, capability grants
  - Access tab becomes editable: replace access document, modify tool rules and capability grants, manage MCP bindings; administrator with hosted reauth, Origin+CSRF, audit
  - Facade wraps GET|PUT /v1/agents/:id/access as /ui/api/agents/:id/access with a safe DTO
  - Every change is a desired-state revision with a visible audit row
  - WCAG 2.1 AA: keyboard operable, labelled controls, contrast, zoom to 200%, screen-reader names on actions

## Source

Console UI sweep 2026-08-26 (docs/architecture/ai-employee-v1-gap-analysis.md, Part
2); decisions 0132, 0135, 0142, 0143. Stories: DESIGN-1, ONBOARD-UI-1, PEOPLE-UI-1, UI-CONN-ACCOUNTS-1, ACCESS-UI-1. UI grill 2026-08-26: one Directory, audit for administrators/approvers, read-only Handoffs, design pass first.
