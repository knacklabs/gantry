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
# Review brief — JOBPERM-2-T1 (once grants: every job-run permission goes through the card)

Facts (live 2026-08-27 16:39Z): a scheduled run's piped `curl … | …` had no persistable rule, so `attachRequest` returned false, the request fell through to the classic chat prompt, and the job-only option rewrite left it with ONLY a Cancel button. Two prompt systems for one run was the defect.

Contract for this diff (AC1–AC4 of plans/active/JOBPERM-2-…md):
- Every job-run request attaches to the card. Need rows carry `grant: 'rule' | 'once'` (once = no persistable rule; request-id identity; no grant atoms). Absent grant reads as `rule`. Stored inside the existing JSONB need/revision record — no migration.
- Row copy for once: "<tool>: <command> (this run only)". Card buttons remain exactly Allow / Deny. Provider renderers untouched.
- Allow on a once row: rails re-checked, NO rule written (decision 0134: a pipe never becomes a durable rule), a signed `allow_once` replayed to the runner; held tool call resumes. Deny unchanged. Rule rows behave exactly as before.
- IPC job branch: attach failure (false/throw) ⇒ tool call denied with "Could not raise the job permission card: <cause>" + one log line; NEVER the classic requester. The `hostJobId` decision-option rewrite in ipc-permission-classifier-decision.ts is deleted.

Focus: (1) any path where a once Allow writes a rule or a once decision replays into a later request/run; (2) reconciler apply/handoff guards that still treat an empty atom set as nothing-to-apply (a once row must settle and replay); (3) identity collisions between once rows and rule rows on the same card; (4) any remaining route from a job-run request to `deps.requestPermissionApproval`; (5) replay signature/decidedBy shape the runner verifies (permission-callback.ts:329). Report ONLY behaviour defects. Ignore style.
# Review brief — JOBPERM-2-T2 (once expiry settlement + Postgres proof of the once chain)

Contract (AC5 + AC2-INT): a `once` need whose waiters are all dead/expired settles as expired — state `cancelled` with `expiredAt`, never `handoff_pending`/`handed_off`, never rerun barriers, never `persistGrant`, never a replay. The card keeps the row, non-decisionable, with copy "Expired — the run ended before a decision; it will ask again next run". A later run raising the same shape creates a fresh once need (request-id identity). Rule rows keep today's handoff semantics. The Postgres integration test drives: scheduled request with no persistable rule → once need + card revision → Allow → reconciler → signed `allow_once` (`decidedBy: human_once`, `updatedPermissions` null) → no rule row written.

Focus: (1) any path where an expired once need later replays, persists, or is reused; (2) rule-need handoff behaviour unchanged; (3) the expired row cannot be tapped into an Allow/Deny (batch actions skip it); (4) integration test asserts the absence of a rule row and the presence of the signed allow_once decision, not just "no error". Report ONLY behaviour defects. Ignore style.
