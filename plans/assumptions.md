# Implementation Assumptions Ledger

One row per assumption made during implementation (`forge plan assume`).
The orchestrator reviews open rows and guides:
`./forge assumptions resolve <id> --status confirmed|fix-needed|promoted --notes "..."`.
`pr_ready.py` refuses while the task has rows at `open` or `fix-needed`.

| id | date | issue | assumption | status | guidance |
|----|------|-------|------------|--------|----------|
| A-0001 | 2026-07-22 | PAY-1 | Baseline File Size Budget inventory was undercounted (5 of 19 rows; truncated read of checker output). Stage E added for the remaining rows; mcp-tool-proxy ratcheted until CAP-1. | confirmed | Confirmed: the checker's File Size Budget had 19 rows, not 5 (truncated baseline read). Stage E split the remaining 13; mcp-tool-proxy ratcheted at 800 (D-0003). check:architecture exits 0 at HEAD. |
