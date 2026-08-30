# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task LEGACY-2-T1

### Plan contracts

- **LEGACY-2-AC1**
  - Source: plans/active/LEGACY-2-remove-the-providerconnection-dual-read.md#acceptance-criteria
  - Statement: the providerConnection shadow field is removed from the runtime settings types and the parser no longer fills it; every providerAccount ?? providerConnection read collapses to providerAccount (settings parser/validation/renderer/exports/reconcile/observer activation, control-plane storage model, CLI provider utils, Slack permission delivery, control routes).
- **LEGACY-2-AC2**
  - Source: plans/active/LEGACY-2-remove-the-providerconnection-dual-read.md#acceptance-criteria
  - Statement: a settings document that still carries providerConnection / provider_connection keeps being rejected by the existing strict key check (no new code); nothing dual-reads it in memory.
- **LEGACY-2-AC3**
  - Source: plans/active/LEGACY-2-remove-the-providerconnection-dual-read.md#acceptance-criteria
  - Statement: the 19 providerConnection entries are deleted from scripts/architecture-exceptions.json and npm run check:architecture passes with no providerConnection exception.
- **LEGACY-2-AC4**
  - Source: plans/active/LEGACY-2-remove-the-providerconnection-dual-read.md#acceptance-criteria
  - Statement: existing unit and Postgres integration suites pass (only assertions that named providerConnection change); tsc green.

### Reviewer focus

- No behaviour change: every providerAccount ?? providerConnection collapses to providerAccount; the Slack approver match stays account-qualified (conversation.providerAccount === providerAccountId).
- Delete the type/parser fill FIRST and let tsc enumerate dependents; no compat shim, no silent-drop of the old document key (the strict key check already rejects it — do not add code for it).
- Rename-only locals (routes/agents.ts, desired-state helpers, runtime-settings.ts setup names) change names only.
- Do NOT touch providerConnectionId (ConversationRoute, identity events, CLI setup return names) or the OpenAPI enum missing_provider_connection (deferral D-0070).
- scripts/architecture-exceptions.json: delete exactly the 19 symbol=providerConnection entries; npm run check:architecture must pass with none left.
