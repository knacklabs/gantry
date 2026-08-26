# Gantry Product Brief

Gantry lets organisations onboard AI employees like real ones: a seat in Teams
or Slack, only the access they need, a full audit trail, and offboarding in one
command. Self-hosted, any model. Under the hood it is a provider-neutral and
channel-neutral agent runtime for teams that need AI agents to run safely inside
product and operations workflows.

## Product Intent

- Run agents behind controlled channel, tool, memory, scheduling, and audit boundaries.
- Let deployments choose channels and model providers without rewriting core runtime behavior.
- Keep customization explicit through prompts, model aliases, capabilities, and conversation installs.
- Make risky actions visible and reviewable through permission, sandbox, and audit flows.

## Positioning Rules (grill, 2026-08-26)

- Governance is the headline; learning is a reviewable record (memory review
  flows), never autonomous drift.
- One central, IT-owned install per organisation. Departments get agents
  inside it; workspace scoping inside the install is the stated path.
- "Agent" in code, CLI, and API; "AI employee" on the landing page and as the
  directory heading only.
- First deployments are KnackLabs engagements (next: a Teams-first
  BFSI/enterprise client); self-serve install serves the organisations after.
- Proof artifact for V1.0: a three-minute real-product video, onboard ->
  scope -> approve via Adaptive Card -> offboard.

## Current Scope

- CLI and package-based runtime setup.
- Slack, Telegram, Teams, Discord, and web or SDK-facing runtime concepts.
- Postgres-backed settings, credential references, memory, jobs, events, and audit state.
- Provider-neutral model routing through catalog aliases and gateway-owned credentials.
- Guided conversation installation for adding one existing agent and provider
  account to additional channel conversations without re-entering credentials
  or editing `settings.yaml`.

## Non-Goals

- A hosted multi-tenant SaaS control plane, as a product Gantry operates for
  customers. Multi-tenant isolation inside a customer's own self-hosted
  deployment (workspace scoping, hostile-tenant hardening) stays in scope —
  see the goals index. (Clarified at sign-off grill, 2026-07-22.)
- A general workflow engine.
- Provider-specific application logic in core runtime.
- Hidden compatibility branches for obsolete local state.
