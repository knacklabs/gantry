---
slug: agent-self-improvement
title: Agent self-improvement by proposal, memory consent, quality signal
status: draft
saved: 2026-08-27T07:38:52+00:00
---

# Agent self-improvement by proposal, memory consent, quality signal

## Capability

An AI employee gets better without a person always editing it — it proposes
changes to its own persona, routines and intro through the same configuration API
the CLI uses, and its owner reviews them or lets low-risk classes auto-apply with an
alert and one-action restore. People are told when personal memory is kept about
them and can opt out. Owners see whether the employee is doing a good job.

## Why

Once the console ships, the CLI's remaining roles are break-glass, automation, and
the agent's own surface. The brief promises reviewable learning; today dreaming can
auto-promote memory and DMs keep personal memory with no opt-out. Making
self-improvement a reviewed revision is what makes the promise true and is a
differentiator neither QM nor Copilot Studio has.

## Behaviour

### Proposals (V1.0.x)

Per decision 0145 an agent may propose revisions only to persona wording, routines
and skills within its library scope, default model within its allowlist, and
intro/help text — never access preset, tool rules, model allowlist, approvers,
owner, connector accounts, or other agents; the boundary is enforced in the
desired-state validator. The owner sets review (approval card) or auto-apply for
named low-risk classes; locked-preset agents are review-only. Applied proposals are
revisions under the agent's own `PrincipalRef`, posted to the admin channel,
restorable in one action.

### Memory governance and consent (decision 0144; V1.1)

Memory promotion, personal memory in DMs, and self-revisions share one knob per
agent. First DM discloses personal memory; opt-out and erase commands exist; state
is shown on the person detail.

### Quality signal (V1.1)

In-chat feedback creates an audited row and notifies the owner; the Handoffs view
gains resolution and handoff rates; owners get a sampled-conversation review list.

## Acceptance criteria

- **SELF-1** — Agent self-improvement by proposal
  - An agent may propose revisions only to: persona wording, routines/skills already in its library scope, default model within its allowlist, intro/help text. Never: access preset, tool rules, model allowlist, approvers, owner, connector accounts, other agents (decision 0145)
  - Owner sets per agent: review (every proposal is an approval card in the owner's conversation) or auto-apply for named low-risk classes; locked-preset agents are review-only and cannot see the machinery
  - Every applied proposal is a revision under the agent's own PrincipalRef with diff, ADMIN-ALERT-1 post, and one-action restore
- **MEMORY-CONSENT-1** — Personal memory consent and opt-out
  - First DM discloses personal memory; opt-out and erase commands; state on the person detail
- **QUAL-1** — Quality signal: feedback and conversation review
  - In-chat feedback (reaction or command) creates an audited row and notifies the owner; Handoffs view gains resolution and handoff rates; weekly sampled-conversation review list per owner

## Source

Product decision 2026-08-27 (one API, three clients); roadmap review; decisions 0144, 0145. Stories: SELF-1, MEMORY-CONSENT-1, QUAL-1.
