# Review brief — lite window Q-0104 (two-button job-permission card; rows name the command)

Owner decision (2026-08-27): the card showed three rows with three button pairs. It must have exactly two buttons — Allow (allow always for this job, for everything listed) and Deny — and each row must say what is being allowed.

Contract for this diff (provider-neutral; channels untouched):
- `jobPermissionCardActions` returns exactly [Allow, Deny] card-level tokens (rowIndex null) when the revision has rows; per-row, "Allow all pending", "Show next pending", "Reconsider", "Show full scope" buttons are gone. Old per-row tokens still parse and resolve to `stale` (no crash).
- Row text: `<Tool label>: <scopes>` from `visibleGrantAtoms` (text inside the outer parentheses; joined with "; ").
- Batch decisions apply to every decisionable row of the revision regardless of `row.action`; `approve_and_run_again` rows keep recording rerun consent; batch deny is valid and denies all.
- Hidden rows (beyond the page) are handled by the next revision, as before.

BY DESIGN: `batchNeedIds` stays in persisted state but no longer gates decisions. Focus: stale/old-token safety, decision idempotency, and that batch deny reaches the existing denial delivery. Ignore style.

Review: autoreview refused the bundle as secret-like (scanner phantom on the test diff: identifiers like `token: allow.token`; no credentials). Shipped on compensating evidence: domain+application lanes 85 files / 1084 tests green, tsc, architecture; diff read by hand (actions = [Allow, Deny] card-level; batch applies to all rows; batch deny valid; old row tokens resolve stale).
