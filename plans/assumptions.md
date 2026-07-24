# Implementation Assumptions Ledger

One row per assumption made during implementation (`forge plan assume`).
The orchestrator reviews open rows and guides:
`./forge assumptions resolve <id> --status confirmed|fix-needed|promoted --notes "..."`.
`pr_ready.py` refuses while the task has rows at `open` or `fix-needed`.

| id | date | issue | assumption | status | guidance |
|----|------|-------|------------|--------|----------|
| A-0001 | 2026-07-22 | PAY-1 | Baseline File Size Budget inventory was undercounted (5 of 19 rows; truncated read of checker output). Stage E added for the remaining rows; mcp-tool-proxy ratcheted until CAP-1. | confirmed | Confirmed: the checker's File Size Budget had 19 rows, not 5 (truncated baseline read). Stage E split the remaining 13; mcp-tool-proxy ratcheted at 800 (D-0003). check:architecture exits 0 at HEAD. |
| A-0002 | 2026-07-24 | SEC-1 | The shared writer accepts a trusted workspace root plus a workspace-relative attachment path so it can prove directory containment instead of trusting a destination path alone. | confirmed | Correct: containment must be proven against the workspace root, not a caller path. |
| A-0003 | 2026-07-24 | SEC-1 | Atomic no-replace publication uses a same-directory hard link from the validated random temp file to the final name, followed by removal of the temp name. | confirmed | Same-directory hard-link publish + temp unlink is the standard no-replace atomic publish; matches decision 0041. |
| A-0004 | 2026-07-24 | SEC-1 | The writer follows the existing descriptor-containment platform contract: Darwin uses O_NOFOLLOW_ANY, Linux validates through /proc/self/fd, and other platforms fail closed. | confirmed | Matches the platform contract already used by workspace-message-attachment.ts; fail-closed elsewhere is right. |
| A-0005 | 2026-07-24 | SEC-1 | Within the SEC-1-T1 write scope, the repository guard lives at .github/workflows/check_ci_runner_isolation.py and is invoked by factory-scaffold.yml. | confirmed | Moved to scripts/check_ci_runner_isolation.py; all references and the workflow-dir resolution updated; guard passes. |
| A-0006 | 2026-07-24 | SEC-1 | The real-model step skips an absent E2E_MODEL_API_KEY with an early successful shell exit so the secret remains scoped to that step instead of the whole job. | confirmed | Early successful skip keeps the secret step-scoped and fork PRs green — exactly decision 0040. |
| A-0007 | 2026-07-24 | SEC-1 | Each workflow defaults contents to read, while jobs that publish branches, packages, issues, or labels retain only the additional write permissions their existing behavior requires. | confirmed | Top-level contents:read with narrowly scoped job-level writes is the intended minimization. |
| A-0008 | 2026-07-24 | SEC-1 | The process-local LLM concurrency admission defaults are 32 global in-flight requests and 8 in-flight requests per app/key. | confirmed | Conservative defaults (global 32, per-key 8) are sensible for a single process; SPS-4 revisits cluster authority. |
| A-0009 | 2026-07-24 | SEC-1 | LLM admission overrides use settings.yaml runtime.llm_admission.global_max_in_flight and runtime.llm_admission.per_app_key_max_in_flight because the ceilings are process-runtime controls, not provider rate limits. | confirmed | runtime.llm_admission.global_max_in_flight / per_app_key_max_in_flight are clear setting names consistent with the runtime.* namespace. |
