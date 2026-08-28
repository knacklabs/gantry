# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task JOBPERM-3-T1

### Plan contracts

- **JOBPERM-3-AC1**
  - Source: plans/active/JOBPERM-3-settled-job-permission-cards-disappear-like-chat-prompts.md#acceptance-criteria
  - Statement: when every row of a job permission card is settled by Allow, the card message is deleted on Telegram, Discord and Slack and edited to a one-line approved receipt on Teams; a failed delete falls back to the receipt edit.
- **JOBPERM-3-AC2**
  - Source: plans/active/JOBPERM-3-settled-job-permission-cards-disappear-like-chat-prompts.md#acceptance-criteria
  - Statement: when the remaining rows of a card have expired (the run ended before a decision), the card is edited to one line per expired request ('Expired: <command>') on every provider — never deleted; a card containing a denied row keeps its live rows (decision 0144: a Deny stays available with one-tap Reconsider) and does not retire.
- **JOBPERM-3-AC3**
  - Source: plans/active/JOBPERM-3-settled-job-permission-cards-disappear-like-chat-prompts.md#acceptance-criteria
  - Statement: the retire outcome (allowed | expired) is carried on the card revision by the shared projection; provider deliveries act on it; retry of a retire revision is idempotent.
- **JOBPERM-3-AC4**
  - Source: plans/active/JOBPERM-3-settled-job-permission-cards-disappear-like-chat-prompts.md#acceptance-criteria
  - Statement: existing unit and Postgres integration suites pass (only new or updated assertions on the retire text/operation); tsc, architecture check green.

### Reviewer focus

- retire outcome derives from need state (expiredAt ⇒ expired), never from text; denied needs never retire (0144)
- delete only when every row allowed; expired ⇒ per-row receipt edit, never delete
- failed delete degrades to the receipt edit exactly once; deletedAt/receiptMessageId gate retries
- per-message lane serialization kept for the delete
- retry-tail sanitizer and the Postgres delivery payload keep the new revision fields

## Task JOBPERM-3-T2

### Plan contracts

- None declared.

### Reviewer focus

No task-specific reviewer focus declared.
