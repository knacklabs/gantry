---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-09
stories: [PSCOPE-1]
---

# Identity-scoped approval authority and per-person grants

## Context

`isControlApproverAllowed` runs the same per-conversation control-approver allowlist for
every conversation, so a person in their own 1:1 DM cannot approve their own agent's tool
requests without being pre-listed, and an empty allowlist (the fresh-chat default) makes
the setup card's grant button a dead end. Separately, durable grants (`agent_tool_bindings`)
are keyed by `(appId, agentId, toolId)` with no person dimension, and provider DMs commonly
share one configured agent folder — so a durable grant approved in one DM silently widens
the shared assistant's access for every other DM and group on that agent. Personal memory is
already isolated per person in DMs via the shipped `personId` model (only DMs may mint a
person; personal memory hydrates only in DMs), but approval authority and grants never
followed that boundary. We want approval and grants to match the DM-personal / room-shared
boundary that memory already honours, uniformly across providers, without forking a separate
agent/persona/brain per DM and without the worker ever self-granting (PERM-2).

## Decision

Approval authority and grant scope become identity-aware on the existing `personId` axis:

- **Kind-aware approval.** In a DM the approver is the DM's own participant, computed from
  the conversation counterpart — no allowlist. In a group/channel the explicit approver
  allowlist still governs. One shared authority path; all other guards (membership,
  same-channel, reserved-decider/PERM-2) are unchanged.
- **Per-person grants.** `agent_tool_bindings` gains a nullable `personId`. `null` = shared
  (agent-level: groups and the baseline for everyone; all existing rows are `null`); a
  non-null `personId` applies only when the agent acts for that person. Effective grants when
  acting for person P = `shared ∪ person(P)`. One assistant brain/persona throughout.
- **Acting identity inherits creation context.** A live DM turn acts for the resolved
  `personId`; a job or API/MCP action acts for the identity scope of the conversation it was
  created in — a DM-created job acts for that person, a group-created job uses shared grants.
- **The acting person IS the memory identity — no separate trust machinery.** The person a
  durable grant is scoped to is exactly the turn's memory identity: `memoryUserId` for live
  turns (host-stamped onto the permission request at creation, from the run registry the host
  populated at spawn — never parsed from the worker payload) and `execution_context.personId`
  for scheduled jobs (persisted at creation, resolved from the job row at grant time; an
  unresolvable job fails closed rather than widening to shared). A turn with no memory person
  (group, or a DM the identity model deems ineligible) simply writes a shared grant — there is
  no separate eligibility gate and no downgrade-to-allow-once path. An elaborate trusted
  contract (run-restriction person routing, host-recorded run kinds, lease-verified classifier
  scoping, ownership checks) was built, reviewed, and deliberately REMOVED: it defended edge
  cases (a compromised worker on a shared agent folder presenting another person's id) whose
  exposure is identical to what person-scoped memory already accepts. That tradeoff is
  accepted; do not rebuild the machinery for it.

## Consequences

- A DM user can action a setup/permission card with no prior allowlist entry; a grant they
  make stays private to them and never leaks to another DM or a group. Offboarding is clean:
  revoking a person retires their grants with them.
- Migration is one-directional (no-backcompat, 0112/0113): existing grants become shared
  (`null`); no compatibility shim.
- Two seams are built as replaceable points so the later organisation tier is additive,
  not a rewrite: **approver resolution** (org adds manager/IT routing) and the **grant scope
  column** (org subdivides `null` into org-policy/team tiers). An org-tier grantable catalog
  would gate the durable write itself. See the org deferral.
- PERM-2 preserved: identity scoping decides *whose* grant applies, not *who may grant* —
  durable grants are still written only after a human decision; the worker never self-grants.
- Out of scope and deferred: organisation roles, an admin-controlled org-policy grantable
  catalog, manager/IT approval routing, a team/company memory-brain hierarchy, and
  person-scoped *credentials* (a person grant needing a shared credential still uses shared
  creds). Alias verification could later tighten the self-grant gate beyond memory-eligibility.
