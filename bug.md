# Gantry Code Audit Findings

This report is based on runtime source and executable checks on commit
`db41baa550a5779f119bf2cfa1b9890856afc69d` (2026-07-27). It does not treat
older documentation or planning notes as proof of current behavior.

## Summary

| ID      | Severity | Finding                                                                | Status                             |
| ------- | -------- | ---------------------------------------------------------------------- | ---------------------------------- |
| BUG-001 | High     | The required lint command fails with 44 errors                         | Confirmed                          |
| BUG-002 | Medium   | Production dependency tree has six known advisories                    | Confirmed                          |
| BUG-003 | Medium   | Published repository metadata points to the former repository          | Fixed in this documentation change |
| BUG-004 | Medium   | Public docs overstate Microsoft Teams runtime support                  | Fixed in this documentation change |
| BUG-005 | Medium   | Caught-error context is lost at three boundaries                       | Confirmed                          |
| BUG-006 | Medium   | An exception is thrown from `finally` in the inbound attachment writer | Confirmed                          |

## BUG-001: The lint gate is red on `main`

Severity: High

Reproduction:

```bash
npm ci
npm run lint
```

Observed:

```text
1096 problems (44 errors, 1052 warnings)
```

The 44 errors include unused imports or variables in runtime paths, lost error
causes, unsafe `finally` control flow, invalid regular-expression lint, and one
`prefer-const` failure. Because `npm run lint` exits nonzero, a clean checkout
cannot pass the repository's documented validation sequence.

Representative locations:

- `apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts:253`
- `apps/core/src/adapters/llm/observability/genai-spans.ts:10`
- `apps/core/src/config/settings/desired-state-service.ts:19`
- `apps/core/src/runtime/group-agent-runner.ts:125`
- `apps/core/src/shared/inbound-attachment-writer.ts:102`

Recommended fix:

1. Remove dead imports and variables or restore the behavior they were intended
   to drive.
2. Fix error-cause propagation and unsafe finalization separately from
   mechanical lint cleanup.
3. Run `npm run lint` in CI as a required check.

## BUG-002: Production dependency advisories

Severity: Medium

Reproduction:

```bash
npm audit --omit=dev
```

Observed: six production vulnerabilities: one low and five moderate.

Affected tree:

- Direct: `@modelcontextprotocol/sdk`
- Direct dependents: `@anthropic-ai/claude-agent-sdk`,
  `@langchain/mcp-adapters`
- Transitive: `hono`, `@hono/node-server`, `body-parser`

Relevant advisories reported by npm include:

- Hono cross-request context disclosure.
- Hono JSX escaping bypass.
- Hono API Gateway repeated-header de-duplication.
- `@hono/node-server` encoded-backslash path traversal on Windows.
- `body-parser` request-size enforcement bypass when given an invalid limit.

Risk note: npm's presence report does not prove every vulnerable code path is
reachable in Gantry. It does prove the affected versions are shipped in the
production dependency tree and need an owner-reviewed upgrade or documented
non-reachability assessment.

Recommended fix:

1. Upgrade the MCP dependency chain to versions that carry patched Hono
   packages.
2. Verify Claude SDK and LangChain MCP compatibility with focused boundary
   tests.
3. Re-run `npm audit --omit=dev`, the 7,460 unit tests, and MCP integration
   suites.

## BUG-003: Repository URLs identify the former home

Severity: Medium

Observed before this documentation change:

- The checkout remote is `https://github.com/knacklabs/gantry.git`.
- The root README clone command and package metadata pointed to
  `https://github.com/cawstudios/Agent.Gantry`.
- SDK and contracts package metadata also pointed to the former repository.

Impact:

- New contributors may clone or report issues against the wrong repository.
- npm consumers may receive stale homepage, repository, and issue links.

Status: fixed in the root README, SDK README, and package manifests by this
change. Historical decision records were left untouched because they are
historical evidence, not current onboarding instructions.

## BUG-004: Microsoft Teams is advertised as an active runtime channel

Severity: Medium

Evidence:

- `apps/core/src/channels/register-builtins.ts` marks Teams with
  `runtime-placeholder`.
- `apps/core/src/channels/provider-account-channel-connect.ts` throws:
  `Microsoft Teams channel runtime transport is not implemented; this provider currently supports setup/discovery only.`
- Existing public overview text grouped Teams with active chat surfaces.

Impact: operators can configure Teams expecting a working runtime connection,
but startup deliberately refuses the placeholder transport.

Status: corrected in the root README, static project explorer, current
architecture pages, and codebase guide. The implementation remains
setup/discovery-only.

## BUG-005: Caught-error context is discarded

Severity: Medium

The lint rule `preserve-caught-error` identifies three runtime boundaries:

- `apps/core/src/adapters/artifacts/skills/remote-first-skill-artifact-store.ts:47`
- `apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/remote-mcp-proxy.ts:365`
- `apps/core/src/shared/skill-artifact-helpers.ts:142`

Impact: callers can receive a replacement error without the original failure as
its `cause`. That makes storage, MCP, and skill-install failures harder to
diagnose and can hide actionable provider or filesystem details from the
operator-facing recovery path.

Recommended fix: capture the original error and attach it with
`new Error(message, { cause: error })`, preserving the outer domain-specific
message.

## BUG-006: Throwing from `finally` can replace the real attachment error

Severity: Medium

Evidence:

`apps/core/src/shared/inbound-attachment-writer.ts:102` triggers
`no-unsafe-finally` because a `ThrowStatement` is reachable from a `finally`
block.

Impact: a cleanup or finalization exception can override the original
attachment failure or an in-flight return value. At a trust boundary that
writes inbound files, losing the primary error makes auditing and recovery
ambiguous.

Recommended fix: capture cleanup failure separately. Preserve the primary
operation error, and throw or log cleanup failure only when no earlier error is
already being propagated.

## Checks That Passed

- `npm run check:architecture`
- `npm run typecheck`
- `npm run build`, including contracts, SDK, runtime, and the Next.js example
- `npm run test:unit` outside the restricted localhost sandbox:
  574 files and 7,460 tests passed
- TypeScript parser scan: 2,097 source files and zero syntax errors

The Postgres-backed integration and end-to-end suites were not treated as
passed because this audit did not provision the required disposable Postgres
instance with `vector` and `pg_trgm`.
