# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task CHAN-1-T1

### Plan contracts

- **CHAN-1-AC1-D**
  - Source: plans/active/CHAN-1-channel-adapters-live-in-one-folder-per-provider.md#acceptance-criteria
  - Statement: apps/core/src/channels/discord-*.ts moved to apps/core/src/channels/discord/*.ts (prefix dropped; discord.ts becomes discord/index.ts) — the Discord half of story AC1; Teams is T2
- **CHAN-1-AC4**
  - Source: plans/active/CHAN-1-channel-adapters-live-in-one-folder-per-provider.md#acceptance-criteria
  - Statement: Lands after PR #444 (JOBPERM-1) merges; branch rebased on main at that point

### Reviewer focus

- renames only (git diff -M ≥90% similarity)
- every import resolves (tsc) and the old-prefix grep is zero
- architecture-budget path entries re-pointed, none dropped
- no exported symbol renamed, no behaviour change

## Task CHAN-1-T2

### Plan contracts

- **CHAN-1-AC1-T**
  - Source: plans/active/CHAN-1-channel-adapters-live-in-one-folder-per-provider.md#acceptance-criteria
  - Statement: apps/core/src/channels/teams-*.ts moved to apps/core/src/channels/teams/*.ts (prefix dropped; teams.ts becomes teams/index.ts) — the Teams half of story AC1
- **CHAN-1-AC2**
  - Source: plans/active/CHAN-1-channel-adapters-live-in-one-folder-per-provider.md#acceptance-criteria
  - Statement: All imports rewritten; no file left at the channels root for Discord or Teams; unit tests for both providers moved under their provider folder or updated in place
- **CHAN-1-AC3**
  - Source: plans/active/CHAN-1-channel-adapters-live-in-one-folder-per-provider.md#acceptance-criteria
  - Statement: No behaviour change: tsc, architecture budgets (paths updated), unit + Postgres integration lanes green; diff consists of renames and import-path edits only

### Reviewer focus

- renames only (git diff -M)
- every import resolves (tsc) and the old-prefix grep is zero
- architecture-map path entries re-pointed, none dropped
- no exported symbol renamed, no behaviour change
