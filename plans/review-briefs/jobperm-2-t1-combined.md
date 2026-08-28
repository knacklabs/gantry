# Plan-contract review brief — JOBPERM-2-T1

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
# Review brief — JOBPERM-2-T1 (once grants: every job-run permission goes through the card)

Facts (live 2026-08-27 16:39Z): a scheduled run's piped `curl … | …` had no persistable rule, so `attachRequest` returned false, the request fell through to the classic chat prompt, and the job-only option rewrite left it with ONLY a Cancel button. Two prompt systems for one run was the defect.

Contract for this diff (AC1–AC4 of plans/active/JOBPERM-2-…md):
- Every job-run request attaches to the card. Need rows carry `grant: 'rule' | 'once'` (once = no persistable rule; request-id identity; no grant atoms). Absent grant reads as `rule`. Stored inside the existing JSONB need/revision record — no migration.
- Row copy for once: "<tool>: <command> (this run only)". Card buttons remain exactly Allow / Deny. Provider renderers untouched.
- Allow on a once row: rails re-checked, NO rule written (decision 0134: a pipe never becomes a durable rule), a signed `allow_once` replayed to the runner; held tool call resumes. Deny unchanged. Rule rows behave exactly as before.
- IPC job branch: attach failure (false/throw) ⇒ tool call denied with "Could not raise the job permission card: <cause>" + one log line; NEVER the classic requester. The `hostJobId` decision-option rewrite in ipc-permission-classifier-decision.ts is deleted.

Focus: (1) any path where a once Allow writes a rule or a once decision replays into a later request/run; (2) reconciler apply/handoff guards that still treat an empty atom set as nothing-to-apply (a once row must settle and replay); (3) identity collisions between once rows and rule rows on the same card; (4) any remaining route from a job-run request to `deps.requestPermissionApproval`; (5) replay signature/decidedBy shape the runner verifies (permission-callback.ts:329). Report ONLY behaviour defects. Ignore style.
