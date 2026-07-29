# Gantry Product Brief

Gantry is a provider-neutral and channel-neutral agent runtime for teams that
need AI agents to run safely inside product and operations workflows.

## Product Intent

- Run agents behind controlled channel, tool, memory, scheduling, and audit boundaries.
- Let deployments choose channels and model providers without rewriting core runtime behavior.
- Keep customization explicit through prompts, model aliases, capabilities, and conversation installs.
- Make risky actions visible and reviewable through permission, sandbox, and audit flows.

## Current Scope

- CLI and package-based runtime setup.
- Slack, Telegram, Teams, Discord, and web or SDK-facing runtime concepts.
- Postgres-backed settings, credential references, memory, jobs, events, and audit state.
- Provider-neutral model routing through catalog aliases and gateway-owned credentials.

## Non-Goals

- A hosted multi-tenant SaaS control plane, as a product Gantry operates for
  customers. Multi-tenant isolation inside a customer's own self-hosted
  deployment (workspace scoping, hostile-tenant hardening) stays in scope —
  see the goals index. (Clarified at sign-off grill, 2026-07-22.)
- A general workflow engine.
- Provider-specific application logic in core runtime.
- Hidden compatibility branches for obsolete local state.
