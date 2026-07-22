# Review Instructions

Use these checks before approving large architecture or runtime changes:

1. Run `npm run check:architecture` or `python3 scripts/check_architecture.py`.
2. Treat any new unexcepted architecture violation as blocking unless the change is explicitly a cleanup that removes more debt than it adds.
3. Review `scripts/architecture-map.json` when a change introduces a new owned layer, adapter family, provider boundary, or package surface.
4. Keep `scripts/architecture-exceptions.json` empty unless a waiver is both deliberate and narrower than changing the map. File line-budget violations are never waived.
5. Provider-specific SDKs, channel SDKs, browser automation, Docker, and direct process execution must stay in approved adapter paths. Core domain and application files should not gain exceptions for these.
6. Legacy group/workspace-era identifiers (the workspace-rename token list pinned in `apps/core/test/unit/architecture/job-notification-cleanup.test.ts`) and Claude-only assumptions should trend down. New files should not introduce them.

When removing debt, delete the matching exception in the same change. If the checker reports that an exception is stale or over-capped, prefer fixing the exception rather than weakening the rule.

## PR policy (client authorization + directives, 2026-07-22)

- The orchestrator IS authorized to push story branches and raise PRs once
  `pr_ready` evidence exists — one PR per story, never bundled.
- MERGING stays human-gated: never auto-merge (this repo has no required
  checks, so `--auto` merges instantly); gate on literal green and an
  explicit human go.
- No session links in PR bodies or commit trailers.
- Every PR that changes runtime behavior adds or extends hermetic agent-e2e
  coverage for it; matrix rows in `docs/architecture/agent-e2e-test-matrix.md`
  flip with test-file citations. A PR with no e2e delta states why in its
  body. The agent-e2e gate is the merge bar.
