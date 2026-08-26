---
status: proposed
confirmed_by: ""
date: 2026-08-26
stories: [CONN-1, OAUTH-1, CONN-GSUITE-1]
---

# Connector accounts run as sandboxed stdio MCP under a supervisor (amends 0137)

## Context

Decision 0137 makes MCP the default execution model for connectors and rule 8
has each Connector Account provision its own MCP server and binding. Today only
remote HTTP/SSE MCP runs (through the host proxy); third-party stdio MCP is
disabled and there is no process supervisor or capacity model. Running one
mailbox per remote service would push connector hosting outside the runtime;
running it as stdio needs supervision.

## Decision

In-repo connector kinds run as stdio MCP processes inside the existing sandbox
(bubblewrap), one process per Connector Account, under a runtime-owned
supervisor that owns start-on-first-use, stop-on-retire, health checks, restart
with backoff, per-host process limits surfaced in doctor, and secret injection
scoped to the account. Third-party stdio MCP remains disabled; only kinds
shipped in this repository may run this way.

## Consequences

- The supervisor is part of CONN-1, not a separate platform.
- Capacity is bounded per host; exceeding it fails account activation with a
  named error rather than degrading silently.
- Remote HTTP/SSE MCP continues to work for non-connector servers; nothing
  moves.
- Opening stdio to third-party kinds requires a new decision covering signing
  and review.
