---
slug: teams-channel
title: Microsoft Teams channel
status: confirmed
saved: 2026-08-26T11:07:54+00:00
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

### Proof

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
- **TEAMS-E2E-1** — Teams real-tenant agent-e2e
  - Fixture/adapter-contract Teams E2E (install, Adaptive Card approval, offboard) runs in the required PR gate
  - Real-tenant run of the same three steps nightly or trusted-label-gated against a deployed endpoint; failure pages the owner
  - ADR 0044 expectation of PR-blocking E2E reconciled with this two-tier strategy in a decision record

## Source

Grill 2026-08-26 (Q10, Q18) and gap sweep (install/docs/Teams: transport stub).
Stories: TEAMS-1, TEAMS-E2E-1.
