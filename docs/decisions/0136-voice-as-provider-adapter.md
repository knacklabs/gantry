---
status: accepted
confirmed_by: "vrknetha"
date: 2026-08-26
stories: []
---

# Voice is a provider adapter, not a runtime

## Context

A working voice engine (telephony, STT/TTS, turn-taking) exists in a separate
KnackLabs repository with its own conversation, session, and tool contract. It
is not shaped like a Gantry provider. Gantry's positioning is "onboard AI
employees like real ones": one identity, one permission gate, one audit trail
across every channel. The product brief forbids provider-specific application
logic in the core runtime, and IDENTITY-01/02 require that identity is
resolved from trusted alias evidence, never inferred, and that every audited
action carries a canonical actor.

The tempting path is to wire the voice repository beside Gantry: its own
session store, its own tool calls, its own log, sharing only the model
gateway. That would ship a second product under Gantry's name whose actions
are invisible to Gantry's audit and permission model — exactly the gap a
security review would find first.

Voice also brings phone-number identity for callers, which IDENTITY-01
explicitly deferred. WhatsApp needs the same slice.

## Decision

Voice joins Gantry only as a provider adapter (`provider: 'voice'`),
implemented after IDENTITY-02 lands and sequenced with WhatsApp in V1.1.

The voice engine stays in its repository and is consumed as a dependency. The
adapter owns native call handling and translates it into Gantry's existing
contracts: one Provider Account per agent, callers as `provider_user` aliases
keyed on the telephony authority and a stable caller id (or anonymous,
conversation-scoped), every tool call through the same permission gate, and
every audited action stamped with the same `PrincipalRef` actor as Teams or
Slack. Human-in-the-loop approvals raised mid-call are delivered through an
existing text surface (Teams, Slack, web); the adapter must not implement its
own approval path.

The voice repository's contract is never merged into core, and no voice
session, tool, or audit state is persisted outside Gantry's runtime.

## Consequences

- Voice is not in V1. V1 is the identity, audit, and offboarding story on
  Teams, Slack, and web. Voice and WhatsApp ship together in V1.1 because
  both need the deferred phone-number alias kind; that slice is built once.
- The adapter is thin only because it targets a finished contract. Starting
  it before IDENTITY-02 lands means building against a moving target and is
  refused.
- Latency-sensitive paths (barge-in, streaming TTS) remain in the engine;
  Gantry is not asked to become a realtime media runtime. If a permission
  check cannot complete within the call's turn budget, the caller is told a
  human is being consulted; the tool call does not proceed on a timeout.
- Voice callers never receive personal memory unless resolved to a Person
  through a trusted alias. Caller-ID display data is metadata, never
  authority.
- Offboarding an agent (`gantry agent offboard`) disables its voice Provider
  Account with every other alias; the engine must tolerate an agent that has
  been retired mid-deployment.
- This closes the door on a standalone voice product sharing only the model
  gateway. Reopening it requires a new decision.
