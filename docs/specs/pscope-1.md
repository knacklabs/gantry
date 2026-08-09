---
slug: pscope-1
title: Person-scoped grants and kind-aware approval authority
status: confirmed
saved: 2026-08-09T16:27:55+00:00
---

# PSCOPE-1 — Person-scoped grants and kind-aware approval authority

## Why

Approval authority and grant scope don't match how people actually use the bot, and they
aren't uniform across providers.

- **Approval is allowlist-only, everywhere.** `isControlApproverAllowed` runs the same
  per-conversation control-approver allowlist for every conversation, including 1:1 DMs.
  So a person talking to the bot in their own DM cannot approve their own agent's tool
  requests unless someone first put them on that conversation's allowlist — and if the
  allowlist is empty (the default on a fresh chat), the setup card's grant button is a
  dead end for everyone.
- **Grants are agent-global, not per-person.** A durable tool grant (`agent_tool_bindings`)
  is keyed by `(appId, agentId, toolId)` — no person or conversation dimension. On real
  channels multiple people's DMs share one configured agent folder, so if one DM user
  approves "allow for future", that grant silently widens the shared assistant's access
  for every other DM and group on that agent. Approving in your own DM is not as private
  as it looks.
- **Group onboarding can't cold-start and is Telegram-only.** The one auto-seed path
  (Telegram group-join) can only propagate an existing approver into a new group; it never
  mints the first one, and no other provider has anything equivalent. A brand-new group has
  no approver, so its grant buttons can't be actioned by anyone.

Personal memory is already isolated per person in DMs (via the shipped `personId` identity
model), but grants and approval authority never followed that boundary.

## Behaviour

- **Kind-aware approval.** In a DM, the person in the DM is inherently authorised to
  approve their own agent's requests — no allowlist, no configuration. In a group/channel,
  the explicit approver allowlist still governs. One shared authority path, all providers.
- **Person-scoped grants.** A grant approved in a DM applies only when the agent is acting
  for that person; it never leaks to other people's DMs or to groups. Group/shared grants
  keep working as today. One assistant brain and persona throughout — `personId` is the
  isolation axis, reusing the identity already resolved at message time.
- **Acting identity follows creation context.** A job (or API/MCP action) uses the grant
  scope of the conversation it was created in: a DM-created job acts for that person; a
  group-created job uses shared grants.
- **Self-grant is gated, not free.** A durable self-grant in a DM is allowed only for a
  person the identity model already considers established (personal-memory-eligible);
  otherwise the person can approve for the current run but not durably. A DM approval spends
  the bot's own infrastructure, so it isn't unconditional.
- **Provider-neutral group bootstrap.** Generalise the Telegram-only onboarding: when the
  bot is installed into a new group by a known person, seed that installer as the group's
  first approver and acknowledge in the group. Where a provider can't reliably identify the
  installer, fall back to manual — authorisation parity is preserved regardless.
- **No agent fork, no re-architecture.** Achieve per-person isolation by scoping grants on
  the existing `personId`, not by minting a separate agent/memory/persona per DM.

Out of scope (recorded as the explicit next initiative): organisation roles
(admin/manager/employee), an admin-controlled org-policy grantable catalog, manager/IT
approval routing, and a team-tier memory/brain hierarchy. This story builds the three
seams those extend — approver resolution, the grant scope column, and the self-grant gate —
so the org layer is additive.

## Acceptance criteria

- In a 1:1 DM, the DM's own user can approve a setup/permission card with no allowlist
  entry; a non-participant cannot. In a group, only allowlisted approvers can (unchanged).
- A durable grant approved in Alice's DM is used when the agent acts for Alice and is NOT
  used for Bob's DM or for a group on the same agent. A shared/group grant applies to
  everyone as before.
- Existing grants continue to apply as shared (agent-level) with no behavioural regression.
- A job created in a DM uses that person's grants at run time; a job created in a group uses
  shared grants. The scope a setup-card grant lands in is the scope the job runs in.
- A durable DM self-grant is permitted only for a personal-memory-eligible person; an
  ineligible person may still approve for the current run only.
- Installing the bot into a new group by a recognised person seeds that person as the first
  approver and posts an in-group acknowledgement, on every provider where the installer is
  identifiable; elsewhere it degrades to manual with a clear in-group message.
- Behaviour is uniform across providers; no per-provider approval logic is added.

## Source

Design grilled with the human 2026-08-09 across six decisions (DM approver = the DM's user;
group first-approver = auto-seeded installer; grant scope = per-person; grant storage =
nullable personId with null = shared; acting identity = inherit creation context; self-grant
gate = reuse personal-memory eligibility), plus an org pressure-test that set the phasing
(foundation now, org governance next, internal employees first). Grounded in four read-only
investigations: approval authorization path, approver-allowlist population, durable
grant scope key, and the identity/owner/sender-allowlist model. Belongs to the
permission-engine epic; builds on ID-1 (person identity) and PREFLIGHT-1 (actionable cards).
