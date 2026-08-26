---
status: accepted
confirmed_by: "vrknetha"
date: 2026-08-26
stories: [CONN-1, CONN-GSUITE-1, IDENT-2]
---

# Connector Accounts mirror Provider Accounts

## Context

Gantry needs a neutral way to add outbound integrations (Google Workspace,
SAP, and whatever comes next) so that several accounts of one kind — three
Gmail mailboxes, say — can each be assigned to a different agent, and adding
an agent stays a separate act from adding an account. The tempting path is a
new "connector platform" with its own account concept, its own credential
store, and eventually a third-party registry.

The shape already exists. A Provider Account is one native identity on a
channel, secrets referenced by `runtime_secret_refs`, owned by exactly one
agent, installed into conversations explicitly. MCP is already the neutral
plugin surface for tools. IDENTITY-02 treats every native identity an agent
holds as an alias of that agent, retired atomically at offboarding. ClawHub
showed what a plugin registry looks like when trust is skipped.

## Decision

Outbound integrations are modelled as Connector Accounts that mirror Provider
Accounts in shape, not in fields:

```
Connector (gmail) → Connector Account (sales@ grant) → owned by Agent (sales)
```

1. **One account, one agent.** A Connector Account is owned by exactly one
   agent. Two agents on the same mailbox are two grants and two accounts.
   Sharing an account across agents is a separate decision with its own audit
   story.
2. **Adding an account and adding an agent are separate acts.** The binding is
   declared explicitly; Gantry never auto-attaches the only account of a kind.
3. **Accounts are agent aliases.** Each Connector Account projects to an
   IDENTITY-02 alias (`connector_account`), appears in the directory beside
   the agent's channel seats, and is retired by `gantry agent offboard`.
4. **Implementation is MCP by default.** A connector is an MCP server the
   runtime launches with the account's secret reference injected. Native
   adapters are allowed only where MCP cannot carry the protocol.
5. **Connector kinds ship in-repo in V1.** No marketplace, no third-party
   registry, no remote install of connector code.
6. **Access is two-layered.** The account carries what the external system
   granted (OAuth scopes); the agent's `tool_rules` carry what Gantry allows.
   Both must permit a call; the audit row records the account used.
7. **Separate table, shared contract.** `connector_accounts` sits beside
   `provider_accounts`; they share the alias projection and offboard hook.
   Merging the tables is not designed up front.

## Consequences

- `CONN-1` builds the account record, secret-ref handling, MCP launch with
  injected account, and the alias/offboard hooks; `CONN-GSUITE-1` is the first
  connector on top of it and introduces no identity record of its own.
- Inbound-transport fields (signing secrets, webhook routes) are not copied
  onto Connector Accounts.
- Per-user delegation ("act as the human who asked") is out of scope; it needs
  the Person's consent and alias and would swallow the identity work.
- A third-party connector registry, if ever wanted, requires a new decision
  covering signing, review, and revocation.
