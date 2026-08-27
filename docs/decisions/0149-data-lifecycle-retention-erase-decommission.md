---
status: proposed
confirmed_by: ""
date: 2026-08-27
stories: [LIFECYCLE-1, IDENT-4, WA-1]
---

# Data lifecycle: retention per class, anonymous erase, decommission

## Context

Retention today is a 30-day live-admission sweep; deletion is tool-event only; IDENT-4 erases verified people. WhatsApp brings anonymous callers, and Indian (DPDP) and EU (GDPR) requests arrive the week it goes live. Contract end needs a clean exit.

## Decision

Retention is a per-class policy (messages, memory, audit) with legal holds; anonymous conversations can be erased by id; a whole deployment can be decommissioned — offboard every principal, export the tenant audit hash-stamped, wipe, and produce a deletion certificate. Audit retention has a floor and is append-only.

## Consequences

- LIFECYCLE-1 implements it in V1.0.x alongside WA-1.
- Retention defaults are conservative and stated in SECURITY.
