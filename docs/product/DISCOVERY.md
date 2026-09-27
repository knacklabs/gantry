# Discovery — myclaw

## Problem

Gantry (this repo) is a provider-neutral, channel-neutral agent runtime.
Product intent lives in `docs/product/BRIEF.md`.

## Stakeholders

- vrknetha — owner/lead dev; acts as PM, EM, and client for this repo.
  Sign-off and decision acceptance are theirs.

## CONV-001 — Add conversations to an existing agent

### Confirmed problem

An operator can already represent one agent in multiple channel conversations
by editing `settings.yaml`, and the canonical backend supports provider-account
conversation discovery and agent conversation installs. The guided workstation
setup does not expose that capability. Operators must know internal settings
keys or Control API calls to add another Slack channel to an existing agent.

### Confirmed user outcome

From completed setup, an operator can choose **Add conversation to existing
agent**, select or enter an existing agent, reuse that agent's existing provider
account and credentials, select a discovered conversation or enter its provider
conversation ID, set conversation approvers and route behavior, review the
result, and save it without editing YAML.

### Constraints

- The operation is additive. Existing agents, provider accounts, credentials,
  and conversation installs are not replaced or removed.
- Manual agent entry must resolve to an existing agent; this flow never creates
  an agent.
- Manual conversation entry must pass provider-specific validation and access
  verification.
- A conversation already installed for the selected agent/provider account is
  rejected as a duplicate rather than silently rewritten.
- Approvers must pass the provider's conversation-membership validation.
- The desired-state service remains the durable write authority; the canonical
  readable `settings.yaml` copy and Postgres/runtime projection stay aligned.
- Conversation topology changes retain the existing restart-required contract.
- The first implementation uses the existing connectable channel-provider
  catalog rather than adding provider-specific behavior to the application
  layer.

### Acceptance checks

- The completed-setup menu exposes **Add conversation to existing agent**.
- The flow supports discovered selection and validated manual entry for agent
  and conversation.
- The review names the agent, provider account, conversation, approvers,
  sender policy, trigger, trigger requirement, and memory scope.
- Saving produces a separate canonical conversation entry with an
  `installed_agents` binding to the existing agent.
- Existing sibling conversation entries and provider secret references remain
  byte-for-byte equivalent after the write.
- Canceling before confirmation writes no desired-state revision.
- Focused unit and integration coverage proves duplicate, ownership,
  membership, cancellation, settings round-trip, and runtime projection
  behavior.
