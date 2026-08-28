# Review brief — JOBPERM-2-T1 (once grants: every job-run permission goes through the card)

Facts (live 2026-08-27 16:39Z): a scheduled run's piped `curl … | …` had no persistable rule, so `attachRequest` returned false, the request fell through to the classic chat prompt, and the job-only option rewrite left it with ONLY a Cancel button. Two prompt systems for one run was the defect.

Contract for this diff (AC1–AC4 of plans/active/JOBPERM-2-…md):
- Every job-run request attaches to the card. Need rows carry `grant: 'rule' | 'once'` (once = no persistable rule; request-id identity; no grant atoms). Absent grant reads as `rule`. Stored inside the existing JSONB need/revision record — no migration.
- Row copy for once: "<tool>: <command> (this run only)". Card buttons remain exactly Allow / Deny. Provider renderers untouched.
- Allow on a once row: rails re-checked, NO rule written (decision 0134: a pipe never becomes a durable rule), a signed `allow_once` replayed to the runner; held tool call resumes. Deny unchanged. Rule rows behave exactly as before.
- IPC job branch: attach failure (false/throw) ⇒ tool call denied with "Could not raise the job permission card: <cause>" + one log line; NEVER the classic requester. The `hostJobId` decision-option rewrite in ipc-permission-classifier-decision.ts is deleted.

Focus: (1) any path where a once Allow writes a rule or a once decision replays into a later request/run; (2) reconciler apply/handoff guards that still treat an empty atom set as nothing-to-apply (a once row must settle and replay); (3) identity collisions between once rows and rule rows on the same card; (4) any remaining route from a job-run request to `deps.requestPermissionApproval`; (5) replay signature/decidedBy shape the runner verifies (permission-callback.ts:329). Report ONLY behaviour defects. Ignore style.
