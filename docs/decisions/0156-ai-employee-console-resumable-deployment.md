---
status: accepted
confirmed_by: "Ravi"
date: 2026-09-07
stories: [IDENT-2, RBAC-1, AUDIT-1, UIFACADE-1, DIR-UI-1, PEOPLE-UI-1, ONBOARD-UI-1, TEAMS-1, TEAMS-E2E-1]
---

# AI employee console: resumable deployment and verified readiness

## Context

The approved console design must take an administrator from a new AI employee
to a working reply in a provider conversation without requiring a terminal.
The earlier console specification assumed one atomic confirmation and inline
receipts only. The shipped Agent modal already persists the base Agent before
later configuration steps, while Provider Accounts, Conversation Installs,
and provider validation are independently durable runtime concepts.

Treating those as an unsaved browser draft would make recovery after a close,
network failure, or deferred channel rollout unreliable. Treating an installed
conversation as ready before it has sent a correlated reply would make the UI
claim health it cannot prove.

## Decision

The console uses AI employee as its product-language noun; Agent remains the
technical code, CLI, API, and diagnostics term. Creation is a seven-step,
resumable modal: Employee, Sources, Capabilities, Account, Conversation,
Approvers, Review. Employee creation atomically creates the Agent, its
service-kind Person, its initial desired-state revision, and its audit event.
Later completed steps persist on that Agent; there is no separate draft
entity. Sources and Capabilities may be skipped individually. Deployment can
be deferred from Account, Conversation, or Approvers, and final review either
finishes without deployment or creates the installation.

The canonical channel hierarchy is Provider -> Provider Account ->
Conversation -> Conversation Installation. Provider Accounts are permanently
owned by one Agent. The browser may create an account inline through the same
write-only form used by Configure > Channel accounts, but it never leaves the
modal or receives a secret value.

Readiness is server-derived and distinct from lifecycle. A deployment reaches
Ready only after configuration is saved, runtime projection succeeds, a unique
challenge is observed inbound, and the Agent's correlated reply is observed
outbound. Failed projection or verification remains retryable and reports
Verification required. Provider availability and member discovery are exposed
as stable browser capabilities, never inferred from raw adapter flags.

Use a unified Directory and an AI employee detail Conversations tab; do not
add a permanent Channels product. A global bottom-right toast stack reports
all mutation outcomes. Actionable validation remains inline and destructive
actions continue to use AlertDialog.

## Consequences

- `console-ai-employee-management` is amended where it says writes occur only
  on final confirmation and where it prohibits toasts.
- Agent setup state, service identity, Provider Account ownership, and
  verification records need durable application and browser contracts.
- An adaptive approver picker may list provider members only when the adapter
  declares discovery support. Otherwise it accepts an ID and validates
  conversation membership before installation; a selected verified member is
  explicitly resolved to a PrincipalRef.
- Slack and Teams must prove this flow against real tenants before release.
  Teams remains setup-only until its runtime transport is delivered.
- Connectors, Usage, Handoffs, editable raw access rules, and browser-based
  risky-action approval remain outside this release.
