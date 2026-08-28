---
slug: teams-channel
title: Microsoft Teams channel
status: confirmed
saved: 2026-08-27T08:49:10+00:00
---



# Microsoft Teams channel

## Capability

A Gantry agent can be given a seat in a Microsoft Teams channel or chat, receive
messages, reply (including streamed replies), ask for and receive approvals via
Adaptive Cards, and be offboarded — against a real Microsoft 365 tenant. Teams is a
first-class channel with the same conversation model, identity resolution, permission
gate, and audit as Slack.

## Why

The next client and the positioning are Teams-first, and the Teams transport is a stub. Nothing can be claimed for Teams until it receives and sends real messages in a real tenant.

## Behaviour

### Transport

- Bot Framework transport behind the existing `TeamsSdkClient` seam: inbound activity
  webhook (messages, card submits, membership), outbound send/update, token
  acquisition for the bot identity. The current stub returning `null` is replaced; the
  factory no longer disables the channel.
- App manifest and Azure Bot registration are documented and scriptable per Provider
  Account; a stable public HTTPS messaging endpoint is a documented deployment
  prerequisite (workstation via tunnel, fleet via ingress).
- Bot/self-sender gate for Teams equivalent to Slack and Discord, and agent-sender
  classification before persistence (agent identity spec).
- Reactions remain deferred (decision 0033); Adaptive Card buttons are the approval
  surface.

#### First contact (INTRO-1)

Once on install, and once on the first @mention by any new person, the agent posts an intro card — name, owner, scope preset, approvers,
how to report a problem — and answers `about` / `help` from the effective
capability catalog. Teams DMs are first-class: discovery covers chats, DM first
contact posts the intro, manifest identity comes from the agent profile. A
report-a-problem action is audited and notifies the owner. A Teams administrator
guide lists least-privilege Graph permissions, tenant-admin consent, and catalog
publishing.

## Proof

- Fixture/adapter-contract E2E (install into a channel, one approval via Adaptive
  Card, offboard) runs in the required PR gate.
- The same three steps run nightly, or trusted-label-gated, against a real tenant and
  a deployed endpoint; failure pages the owner. Decision 0044's PR-blocking E2E
  expectation is reconciled with this two-tier strategy in a decision record.
- A Teams operator quickstart lives beside the Slack one.

## Acceptance criteria

- **TEAMS-1** — Teams transport: Bot Framework, manifest, endpoint
  - createMicrosoftTeamsSdkClient returns a working Bot Framework transport (receive + send + Adaptive Card submit); teams-factory no longer disables the channel
  - App manifest and Azure Bot registration documented and scriptable; stable public HTTPS messaging endpoint documented
  - Bot/self-sender gate for Teams matching Slack and Discord
  - Teams operator quickstart under docs/operations
  - Teams administrator guide: exact Graph permission list (least privilege), tenant-admin consent, org-catalog publishing vs sideloading
- **TEAMS-E2E-1** — Teams real-tenant agent-e2e
  - Fixture/adapter-contract Teams E2E (install, Adaptive Card approval, offboard) runs in the required PR gate
  - Real-tenant run of the same three steps nightly or trusted-label-gated against a deployed endpoint; failure pages the owner
  - ADR 0044 expectation of PR-blocking E2E reconciled with this two-tier strategy in a decision record
- **INTRO-1** — First contact: the AI employee introduces itself
  - On conversation install the agent posts an intro card: name, owner, scope preset, approvers, how to report a problem; the same card answers @agent about or help, derived from the effective capability catalog, not free text
  - Teams DMs are first-class: discovery covers chats, DM first-contact posts the intro, manifest name/icon/description come from the agent profile
  - A report-a-problem action creates an audited row and notifies the owner via ADMIN-ALERT-1
  - The intro card posts once on install and once on the first @mention by any new person; it never repeats for the same person

## Source

Grill 2026-08-26 (Q10, Q18) and gap sweep (install/docs/Teams: transport stub).
Stories: TEAMS-1, TEAMS-E2E-1.
