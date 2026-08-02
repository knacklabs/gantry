---
slug: person-identity-aliases
title: Person identity and provider-neutral aliases
status: confirmed
saved: 2026-08-01T13:30:46+00:00
---

# Person identity and provider-neutral aliases

## Capability

Gantry resolves `where a message happened` and `who sent it` as separate facts. Every app
holds its own identity graph: a canonical `personId` per human (or service principal),
with provider identities, email addresses, phone numbers and web/OIDC subjects attached
as aliases. The agent treats the same human as the same person whichever channel they
arrive from; personal memory follows the person in direct conversations, conversation
memory stays with the room.

## Identity model

- Person: app-scoped, `kind: human | service`, status active/disabled/archived. The same
  human in two Gantry apps is deliberately two unrelated people (tenancy boundary;
  "forget me" stays tractable).
- Alias key: `(appId, provider, providerAccountId?, externalUserId)`, exact-match lookup
  only. `provider` is a free lowercase string — slack/telegram/teams today; whatsapp,
  email, phone, oidc tomorrow without schema change.
- OIDC logins alias as provider `oidc`, providerAccountId = issuer, externalUserId =
  `sub`. Never keyed on email; the email is a separate contact alias.
- Contact aliases are normalised at write time: email lowercased, phone to E.164.
- Verification: `verified | unverified | retired` with evidence. `verified` is set only
  by flows that prove control (provider event, OIDC login, future OTP; connector OAuth
  for agent-owned accounts). The People API cannot set it.
- No auto-linking: matching email/phone across providers yields a suggestion for
  explicit confirmation, never an automatic link.
- Merge: an operator can merge two people (aliases re-key to the target, source is
  archived; memories and messages are never re-keyed). Every merge is auditable and
  reversible via unmerge from `person_merge_audit`.
- Agents: once connectors land, agent-owned identities (email, GitHub) attach as aliases
  to `kind: service` persons. Live resolution never mints a person for an agent/system
  sender; merges never cross kinds; personal-memory hydration stays human-only.

## User types

No type column. Admin = authorization (API-key scopes, later OIDC claims). Org employee
= has a verified alias from the org IdP. Application user = everyone else. Derived,
never stamped.

## Memory boundary

- Conversation memory is conversation-scoped, always.
- Personal memory attaches only in direct/private turns whose sender resolves cleanly.
- Group/channel turns resolve identity for audit evidence but never append personal
  memory; an unresolved sender never rewrites a conversation into a person.
- Future exposure of memories to external clients (memory-MCP) authenticates per person
  within an app — never admin keys, never cross-app.

## Control surface

People API under control-key scopes `people:read` / `people:admin`: resolve, list,
inspect person, add alias (arrives unverified), retire alias, preview merge, apply
merge, unmerge. All mutations audited with actor attribution.

## Source

Derived from PR #217 (Suraj Bangade) plus the eight decisions grilled and locked with
Ravi on 2026-08-01 and decision 9 (agents as service-kind people) added the same day.
Implementation detail: docs/phase-2-3-identity-management.md on the feature branch.
