---
slug: connector-accounts
title: Connector accounts
status: confirmed
saved: 2026-08-26T11:07:54+00:00
---

# Connector accounts

## Capability

An administrator adds several accounts of one connector kind — three Gmail mailboxes,
say — and assigns each to a different agent. Access is per account and per agent; two
agents never share a grant by accident. A Connector Account is the outbound twin of a
Provider Account and an alias of its agent, so it appears in the directory and is
retired at offboarding (decision 0137).

## Why

'Only the access they need' must be demonstrable on tools every org has, per account and per agent. Today MCP credentials are per server, stdio is disabled, and no connector OAuth exists.

## Behaviour

### Account model

- `connector_accounts`: kind, owning agent (exactly one), label, flat
  `external_identity_ref` (string fields), `runtime_secret_refs`. Declared in desired
  state and projected to Postgres like Provider Accounts; the binding to an agent is
  explicit, never inferred from being the only account of a kind.
- Each account projects to a `connector_account` alias on the agent's service Person.
- Kinds ship in-repo; no marketplace, no remote connector install.

### Execution

- Each account materialises one dedicated MCP server definition plus agent binding
  with a scoped secret projection; servers are never shared across accounts.
- Sandboxed stdio MCP is enabled for in-repo connector kinds only, under a supervisor
  that owns process limits, health checks, restart with backoff, and per-account
  lifecycle (start on first use, stop on retire). Third-party stdio MCP stays
  disabled. Capacity is bounded per host and surfaced in doctor.
- Authorization is two-layered: the account's granted scopes are evaluated before the
  agent's tool rules; both must permit. `connectorAccountId` is a first-class field in
  MCP tool audit.

### OAuth platform

- Authorization-code with PKCE and state; callback route classified per decision 0132;
  scope validation against the connector kind's declared scope set.
- Refresh tokens stored encrypted behind secret references; refresh, rotation, and
  revoke owned by the platform; tokens never appear in settings, logs, or audit.
- Grant, refresh, and revoke are audited with redaction.

### First connector: Google Workspace

Gmail, Drive, Calendar as one kind with explicit scopes; per-agent grant through the
OAuth platform; introduces no identity record of its own. Existing Google OIDC
(console login) and Vertex service-account credentials are not reused for Workspace.

## Acceptance criteria

- **CONN-1** — Connector Account platform
  - connector_accounts record mirrors Provider Account shape: kind, agent, label, external_identity_ref, runtime_secret_refs; exactly one owning agent
  - A connector is launched as an MCP server with the account's secret ref injected; native adapters only where MCP cannot carry the protocol
  - Each account projects to an IDENT-2 connector_account alias and is retired by gantry agent offboard
  - Account scopes and agent tool_rules are both enforced; audit rows record the account used
  - No marketplace or remote connector install; kinds are in-repo
  - One account creates one dedicated MCP server definition + binding with a scoped connector-secret projection; servers are never shared across accounts
  - Execution topology chosen: remote HTTP/SSE MCP via host proxy (default) or bounded sandboxed stdio supervision with process limits and health; stdio third-party MCP stays disabled unless this lands
  - connectorAccountId is an authorization input evaluated before tool_rules and a first-class field in MCP audit
- **OAUTH-1** — Connector OAuth platform
  - Authorization-code + PKCE flow with state, scope validation, callback route classified per ADR 0132
  - Encrypted refresh-token store via secret refs; refresh, rotation, revoke; tokens never in settings, logs, or audit
  - Redacted audit contract for grant, refresh, revoke
- **CONN-GSUITE-1** — Google Workspace connector
  - Per-agent OAuth grant with explicit scopes; tokens via secret refs, never in settings or logs
  - Every Workspace tool call passes the permission gate and is audited
  - Introduces no agent identity record of its own; any per-agent Google principal is a CONN-1 Connector Account

## Source

Decision 0137 (as amended), grill 2026-08-26 and spec round (stdio supervisor chosen
over remote-only); gap sweep (connectors). Stories: CONN-1, OAUTH-1, CONN-GSUITE-1.
