# QUALITY.md

## Quality Bar

Every change must pass five independent checks:

1. automated tests
2. deterministic verify (structural, architecture, typecheck, tests)
3. quality review
4. performance review
5. security review
6. functional check

## Test Architecture

Production source trees are test-free:

- `apps/core/src/**`
- `packages/*/src/**`

Tests and harnesses must use:

- `apps/core/test/unit/**`
- `apps/core/test/integration/**`
- `apps/core/test/e2e/**`
- `apps/core/test/harness/**`
- `packages/contracts/test/unit/**`

Default test gate:

- `npm test` must run contracts build + unit + integration suites.

Explicit e2e gate:

- `npm run test:e2e` must run hermetic runtime flows without external credentials (Telegram, Slack, Claude, OpenAI, browser, or network auth).
- e2e and integration tests must not use real runtime home paths (`~/gantry`), repo `store/`, repo `data/`, or real user credential files.
- Feature integration tests should exercise concrete recent capabilities through their real adapter/application/domain boundaries. Use shared harnesses in `apps/core/test/harness/**`; Postgres-specific tests must create a unique schema and skip cleanly when `GANTRY_TEST_DATABASE_URL` is unset.
- DB-backed changes require explicit evidence from `npm run test:integration:postgres` with `GANTRY_TEST_DATABASE_URL` set. The default `npm test` gate remains credential-free, but it is not sufficient evidence for Postgres repository, FileArtifact, durable message, job, run, or memory changes.

## Review Subagents

### quality-reviewer

- model: `gpt-5.5`
- reasoning: `high`
- mode: `read-only`
- focus: correctness, regressions, maintainability-as-risk, test gaps, contract drift

### performance-reviewer

- model: `gpt-5.5`
- reasoning: `high`
- mode: `read-only`
- focus: hot paths, algorithmic complexity, query fanout, I/O amplification, memory churn, concurrency bottlenecks
- must distinguish measured evidence from inference

### security-reviewer

- model: `gpt-5.5`
- reasoning: `high`
- mode: `read-only`
- focus: OWASP-style trust boundaries, authn/authz, secrets, injection, data exposure, unsafe defaults, abuse paths

## Testing Subagents

### automated-tester

- model: `gpt-5.3-codex`
- reasoning: `high`
- mode: `workspace-write`
- focus: add or update automated tests, run scoped test commands, report remaining gaps

Required output:

- `status`
- `summary`
- `tests_added_or_updated`
- `commands_run`
- `pass_fail_summary`
- `blocking_findings`
- `remaining_gaps`
- `reviewed_scope`

### functional-checker

- model: `gpt-5.5`
- reasoning: `high`
- mode: `workspace-write` when tooling needs artifacts, otherwise `read-only`
- focus: user-visible behavior, end-to-end flows, browser/runtime checks, manual-validation quality

Required output:

- `status`
- `score`
- `summary`
- `manual_validation_steps`
- `blocking_findings`
- `non_blocking_findings`
- `residual_risks`
- `recommendation`
- `reviewed_scope`

## Artifact Contracts

Review artifacts live under `.factory/reviews/`.

Testing artifacts live in `.factory/tests.json` with two top-level keys:

- `automated`
- `functional`

PR-ready requires:

- no testing blockers
- no review blockers
- review scores >= 8
- evidence for acceptance criteria

Validation commands:

- `python3 .codex/scripts/validate_artifacts.py` checks artifact shape and gate thresholds
- `python3 .codex/scripts/validate_work.py` runs verify + artifact validation and marks PR-ready on success

Recommended implementation verification commands:

```bash
npm run test:unit
npm run test:integration
GANTRY_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/gantry_test npm run test:integration:postgres
npm test
npm run test:e2e
npm run build
python3 .codex/scripts/verify.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/validate_work.py
```
