---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-09
amended: 2026-08-10
stories: [PSCOPE-1, PSCOPE-2]
---

# Provider-neutral group installer auto-seed for the first approver

## Context

A group/channel's grant buttons are useless until the conversation has a control approver,
and that allowlist is populated only manually (CLI / API / `settings.yaml`). The single
auto-seed path — Telegram group-join onboarding — can only *propagate* an approver who
already exists elsewhere into a new group; it cannot mint the first one, and no other
provider has any equivalent. So a brand-new group is a dead end: the card appears and nobody
can act on it. With kind-aware approval (0118) the DM side needs no bootstrap, but groups
still need a provider-neutral way to acquire their first approver.

## Decision

Generalise the Telegram-only onboarding into a provider-neutral bootstrap: when the bot is
installed into a new group by a **recognised** person (an identity the system already knows —
e.g. one with a resolved `personId` / existing DM), seed that installer as the group's first
control approver and post a short **in-group acknowledgement**. Where a provider cannot
reliably identify the installer (e.g. Discord/Teams inviter data), fall back to manual with a
clear in-group message naming how to set an approver. The installer is never granted anything
beyond becoming an approver, and an unrecognised installer seeds nobody (fail-closed).

**Amendment (2026-08-10, confirmed by Ravi during the PSCOPE-2 grill):**

- **Recognition IS the registration gate.** A recognised installer auto-registers the group
  and becomes its first approver in one step. This SUPERSEDES the Telegram DM Yes/No
  propagation gate, which is deleted (not kept alongside) — it could never mint a first
  approver and never posted in the group.
- **Recognised = DM-established**, not merely alias-resolvable: the installer's alias must
  resolve to a person (`createIfMissing: false`; a retired alias counts as unrecognised) AND
  that person must have an existing direct conversation with the bot. Aliases alone are too
  loose — they auto-mint for anyone who ever spoke in a shared group.
- **v1 providers:** Telegram + Slack extract the installer (Slack requires the
  `member_joined_channel` event + read scopes in the app manifest — an ops step, documented);
  Discord posts the manual-setup message on new-guild join (its events carry no inviter);
  Teams is documented-manual until its activity surface exists.

## Consequences

- Groups cold-start on the providers that expose the installer (Telegram/Slack) and degrade
  gracefully elsewhere; authorization parity across providers is preserved regardless, since
  only the *auto-seed* differs, not the approval check.
- The group is never left in dead air on install (closes the earlier UX gap): action happens
  in the room, the approval decision stays with a real approver.
- PERM-2/authority preserved: seeding an approver is not a tool grant; it only records who may
  later approve, and only from a recognised identity.
- Provider-specific installer-identity extraction is the one non-neutral input; it is isolated
  so adding a provider later is local. Verified-identity gating of the installer could tighten
  this in the org phase.
