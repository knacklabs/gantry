---
status: proposed
confirmed_by: ""
date: 2026-08-26
stories: [IDENT-2, AUDIT-1, IDENT-4]
---

# Agents are service-kind Persons, not a second principal type

## Context

The confirmed spec `person-identity-aliases` (decision 9, 2026-08-01) already
states that agent-owned identities attach as aliases to `kind: service` Persons.
The IDENTITY-02 extension drafted on 2026-08-26 proposed a separate `Agent`
principal with its own `PrincipalRef` kind. Two principal types would mean two
lifecycles, two alias projections, and two offboarding paths to keep aligned —
the very duplication the "onboard AI employees like real ones" positioning is
meant to remove.

## Decision

An agent's canonical identity is a `kind: service` Person bound one-to-one to its
`agentId`, created with the agent and never minted from a live message. Provider
Accounts and Connector Accounts are aliases of that Person (`provider_account`,
`connector_account`). `PrincipalRef` is `{ kind: human | service | system,
personId?, aliasId? }`. One alias table, one uniqueness rule across kinds, one
offboard use case for both kinds. IDENTITY-02 is reconciled to this model; the
spec `agent-identity-and-offboarding` is the contract.

## Consequences

- No `agents`-as-principals table; `agentId` remains the configuration key and the
  binding field on the service Person.
- Live resolution never mints a Person for a service sender; merges never cross
  kinds; personal-memory hydration stays human-only (unchanged from decision 9).
- Audit, directory, roles, and approvers all key on `personId`, so people and
  agents are indistinguishable in shape and distinguishable only by `kind`.
- Reopening a separate agent principal type requires a new decision.
