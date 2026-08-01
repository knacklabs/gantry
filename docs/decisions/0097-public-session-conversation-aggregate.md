---
status: accepted
confirmed_by: "user"
date: 2026-07-29
---

# Public sessions use canonical conversation aggregates

## Context

The Control API session UUID is a public handle stored separately from the
runtime agent-session UUID created for a turn. A public session can contain
root and threaded runs and can be rebound to another agent. Using the public
UUID as a runtime-session lookup key makes runs and runtime events disappear.

## Decision

Treat a public session as the app-scoped canonical conversation aggregate.
Resolve session messages, runs, and runtime events by `appId` plus canonical
`conversationId`, including all internal runtime sessions, agents, and
threads belonging to that conversation.

## Consequences

- The public session UUID remains an authorization and routing handle, not a
  runtime persistence key.
- Agent rebinds preserve conversation observability and history.
- Queries must constrain both app and canonical conversation identity.
- A separate contract decision is required before exposing one provider
  session for a conversation that may have several provider sessions.
