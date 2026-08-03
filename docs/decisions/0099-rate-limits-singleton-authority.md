---
status: proposed
confirmed_by: ""
date: 2026-08-03
stories: [SEC-4]
---

# Rate Limits Singleton Authority

## Context

Runtime rate limits (LLM admission, provider send throttles, per-app caps) are
enforced with in-memory counters inside one process. If several runtime
instances ever ran against the same database, each instance would enforce its
own copy of every limit, multiplying the effective cap by the instance count.
The audit harvest (0102) flagged this as SEC-4 and asked for either a
cluster-authoritative counter store or an explicit declaration that the runtime
is single-instance for rate-limit purposes.

Gantry today runs as exactly one launchd-managed instance per host, and no
multi-instance deployment shape exists or is planned near-term.

## Decision

The runtime is declared **single-instance-authoritative for rate limiting**.
In-memory counters are correct by deployment contract; no shared counter store
is built now.

Revisit trigger: the moment any work introduces a second concurrently running
runtime instance sharing one database (horizontal scale, blue/green overlap,
worker fleets), that work MUST move rate-limit counters to a
cluster-authoritative store (Postgres) before shipping, and this decision is
superseded.

## Consequences

- Zero code now; SEC-4 closes as decided-by-record.
- The single-instance assumption becomes an explicit, searchable contract
  rather than an accident — future fleet work has a named tripwire.
- Accepted risk: if someone launches a second instance in violation of the
  contract, limits over-admit until the trigger is honored.
