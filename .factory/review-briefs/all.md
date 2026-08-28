# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task JOBPERM-2-T1

### Plan contracts

- **JOBPERM-2-AC1**
  - Source: plans/active/JOBPERM-2-job-permissions-one-card-path-with-rule-once-grants.md#acceptance-criteria
  - Statement: a job-run request with no persistable rule creates a `once` need row and a card revision with Allow / Deny; no classic prompt is sent and the job-only cancel-only option rewrite no longer exists.
- **JOBPERM-2-AC2**
  - Source: plans/active/JOBPERM-2-job-permissions-one-card-path-with-rule-once-grants.md#acceptance-criteria
  - Statement: Allow on a `once` row replays a signed `allow_once` to the runner, writes no rule, and the held tool call resumes; Deny denies; the card settles and logs delivery as today.
- **JOBPERM-2-AC3**
  - Source: plans/active/JOBPERM-2-job-permissions-one-card-path-with-rule-once-grants.md#acceptance-criteria
  - Statement: `rule` rows behave exactly as before (rule write + replay); existing rows without a mode read as `rule`.
- **JOBPERM-2-AC4**
  - Source: plans/active/JOBPERM-2-job-permissions-one-card-path-with-rule-once-grants.md#acceptance-criteria
  - Statement: a job attach failure denies the tool call with a logged plain reason instead of falling through to the chat prompt.

### Reviewer focus

- a once Allow never writes a rule (0134) and replays a signed allow_once the runner accepts
- reconciler apply/handoff guards no longer treat an empty atom set as nothing-to-apply
- absent grant reads as rule; existing rule rows unchanged
- IPC job branch never reaches the classic requester; failure denies with a reason and a log line
- buttons remain exactly Allow / Deny; provider renderers untouched

## Task JOBPERM-2-T2

### Plan contracts

- **JOBPERM-2-AC5**
  - Source: plans/active/JOBPERM-2-job-permissions-one-card-path-with-rule-once-grants.md#acceptance-criteria
  - Statement: a `once` row whose run ended before a decision settles as expired with copy "Expired — the run ended before a decision; it will ask again next run" and never becomes durable authority.
- **JOBPERM-2-AC2-INT**
  - Source: plans/active/JOBPERM-2-job-permissions-one-card-path-with-rule-once-grants.md#verify-plan
  - Statement: Postgres integration proof: a signed scheduled once-card attach → Allow → `allow_once` replay with no rule written (permission-decision-chain suite).

### Reviewer focus

- an expired once row never replays and never persists a rule
- expired copy renders on the card; rule rows untouched
- integration test drives attach → Allow → signed allow_once replay with no rule row written
