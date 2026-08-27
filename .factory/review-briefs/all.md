# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task CHAN-2-T1

### Plan contracts

- **CHAN-2-AC1**
  - Source: plans/active/CHAN-2-channel-dispatchers-flatten-repeated-guards-and-split-the-telegram-callback-by-action-kind.md#acceptance-criteria
  - Statement: The five review hoists are applied: telegram/message-action-affordances.ts dead early-returns removed; telegram/channel-connect.ts callback context computed once; slack/channel-message-action-handler.ts channelId/userId hoisted; discord/interactions.ts component user id hoisted; teams/cards.ts thread fragment computed once
- **CHAN-2-AC4**
  - Source: plans/active/CHAN-2-channel-dispatchers-flatten-repeated-guards-and-split-the-telegram-callback-by-action-kind.md#acceptance-criteria
  - Statement: Lands after PR #446 merged (CHAN-1 folder layout); branch based on main after it

### Reviewer focus

- each hoist is behaviour-preserving (same guards, evaluated once)
- no existing test edited
- no signature change

## Task CHAN-2-T2

### Plan contracts

- None declared.

### Reviewer focus

No task-specific reviewer focus declared.
