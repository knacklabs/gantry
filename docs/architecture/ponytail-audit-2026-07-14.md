# Ponytail Whole-Repository Audit — 2026-07-14
<!-- doc-references: frozen 2026-07-22 (decision 0036) -->

## Outcome

This was an audit-only review for unnecessary complexity, dead code, removable
indirection, unused dependencies, and native-platform replacements. No fixes
were applied during the audit.

The initial report was subjected to two adversarial falsification passes. The
corrected, overlap-adjusted estimate is:

- **1,168 repository lines removable**
- **5 direct dependencies removable**
- Generated `package-lock.json` pruning is excluded from the line estimate.

Confidence is high for consumers visible inside this repository. It is not a
mathematical guarantee against undocumented external deep imports or humans
manually invoking unreferenced scripts.

## Ranked Findings

### 1. Delete the archived filesystem-memory importer

- Tag: `delete`
- Estimated reduction: 418 lines
- Path: `.codex/scripts/migrate_archived_filesystem_memory.mjs`
- Evidence: no repository references beyond the script itself; it contains
  hardcoded legacy routing defaults and imports unsupported filesystem memory
  into current Postgres state.
- Replacement: nothing.

### 2. Delete the unused fake agent-runner harness

- Tag: `delete`
- Estimated reduction: 112 lines
- Path: <code>apps/core/test/harness/fake-agent-runner.ts</code>
- Evidence: `createFakeAgentRunner` and its exported types occur only in their
  declarations; text, semantic, structural-call, dynamic-import, and test
  searches found no consumer.
- Replacement: nothing.

### 3. Remove eleven re-export-only files and nine temporary exceptions

- Tag: `delete`
- Estimated reduction: 90 lines
- Paths:
  - <code>apps/core/src/channels/slack.ts</code>
  - <code>apps/core/src/channels/slack/channel.ts</code>
  - <code>apps/core/src/channels/telegram.ts</code>
  - <code>apps/core/src/channels/telegram/channel.ts</code>
  - <code>apps/core/src/memory/index.ts</code>
  - <code>apps/core/src/messaging/index.ts</code>
  - <code>apps/core/src/platform/index.ts</code>
  - <code>apps/core/src/runtime/index.ts</code>
  - <code>apps/core/src/session/index.ts</code>
  - <code>apps/core/src/config/security-posture.ts</code>
  - <code>apps/core/src/jobs/job-plan-formatter.ts</code>
  - `.codex/architecture-exceptions.json`
- Evidence: the files contain only re-exports. Seven have no consumers; four
  have repository consumers that can import the owned target directly. The
  nine matching architecture exceptions explicitly describe temporary
  wrapper compatibility debt.
- Replacement: direct imports from the owned implementation modules.

### 4. Delete the duplicate scheduler capability schema

- Tag: `delete`
- Estimated reduction: 86 lines
- Path: `apps/core/src/runner/mcp/tools/scheduler-capability-schema.ts:120`
- Evidence: `schedulerCapabilityRequirementSchema` occurs only at its
  declaration. The live `schedulerAccessRequirementSchema` already owns the
  corresponding validation.
- Replacement: nothing.

### 5. Consolidate copied IPC signing and envelope primitives

- Tag: `shrink`
- Estimated reduction: at least 72 lines after replacement code
- Paths:
  - <code>apps/core/src/runner/mcp/signing.ts</code>
  - `apps/core/src/runner/permission-ipc-client.ts`
  - <code>apps/core/src/adapters/llm/anthropic-claude-agent/runner/ipc-signing.ts</code>
- Evidence: the HMAC request signing and Ed25519 response verification are
  repeated. Envelope expiry behavior is not identical: the MCP implementation
  preserves a caller-supplied `expiresAt`, while the permission implementations
  synthesize it.
- Replacement: neutral shared signing and envelope primitives that preserve an
  existing `expiresAt` and synthesize one only when absent.

### 6. Delete orphan scheduler code and four uncalled job helpers

- Tag: `delete`
- Estimated reduction: 70 lines
- Paths and symbols:
  - <code>apps/core/src/jobs/ipc-scheduler-approval-target.ts</code> —
    `resolveSchedulerApprovalTarget`
  - `apps/core/src/application/jobs/job-capability-requirements.ts` —
    `capabilityRequirementToolRules`
  - `apps/core/src/application/jobs/job-recovery-intent-service.ts` —
    `shouldRunRecoveryIntent`
  - `apps/core/src/jobs/job-notification-routes.ts` — `notificationRouteKey`
  - `apps/core/src/jobs/scheduler.ts` — `runSchedulerTick`
- Evidence: exact and structural call searches found declarations only.
- Replacement: nothing.

### 7. Delete two orphan modules and an unused repository test seam

- Tag: `delete`
- Estimated reduction: 61 lines
- Paths:
  - <code>apps/core/src/config/env/parse.ts</code> — 14 lines
  - <code>apps/core/src/adapters/storage/postgres/schema/canonical-json.postgres.ts</code>
    — 12 lines
  - `apps/core/src/adapters/storage/postgres/runtime-store.ts:216` — the
    35-line `_setRuntimeRepositoriesForTest` seam
- Evidence: neither module is imported or re-exported, and the test seam has no
  call site.
- Replacement: nothing.

### 8. Delete the superseded test-result recorder

- Tag: `delete`
- Estimated reduction: 51 lines
- Path: `.codex/scripts/record_test_result.py`
- Evidence: no caller references the flag-by-flag recorder. The documented,
  scaffold-required workflow uses `record_test_from_json.py`.
- Replacement: `.codex/scripts/record_test_from_json.py`.

### 9. Delete the unreferenced Postgres-test wrapper

- Tag: `delete`
- Estimated reduction: 32 lines
- Path: `.codex/scripts/run_postgres_integration_with_url.mjs`
- Evidence: no caller or documentation references it. The canonical package
  script already enforces the approved focused Postgres suite.
- Replacement: set `GANTRY_TEST_DATABASE_URL` and run
  `npm run test:integration:postgres`.

### 10. Delete three unused runtime convenience wrappers

- Tag: `delete`
- Estimated reduction: 30 lines
- Paths and symbols:
  - `apps/core/src/runtime/browser-cdp-targets.ts:551` — `browserTargetUrl`
  - `apps/core/src/runtime/group-run-context.ts:38` —
    `resolveTurnSelectedSkillIds`
  - `apps/core/src/runtime/progress-updates.ts:9` —
    `buildDoneProgressOptions`
- Evidence: exact searches found declarations only; structural searches found
  no calls.
- Replacement: the existing lower-level functions already used by live paths.

### 11. Delete two unused optional-input normalizers

- Tag: `delete`
- Estimated reduction: 26 lines
- Path: `apps/core/src/application/jobs/job-tool-access-requirements.ts`
- Symbols:
  - `normalizeToolAccessRequirementsInput`
  - `normalizeRequiredMcpServersInput`
- Evidence: both symbols occur only at their declarations.
- Replacement: nothing; live callers already use the canonical normalizers.

### 12. Delete the orphan session-summary prompt

- Tag: `delete`
- Estimated reduction: 26 lines
- Path: <code>apps/core/src/memory/prompts/session-summary.ts</code>
- Evidence: `SESSION_SUMMARY_PROMPT` occurs only in this file across source,
  tests, packages, documentation, and generated output.
- Replacement: nothing.

### 13. Replace the GitHub-comment wrapper with native `gh`

- Tag: `native`
- Estimated reduction: 26 lines
- Path: `.codex/scripts/sync_github.py`
- Evidence: no caller or documentation references it; the implementation only
  dispatches to `gh pr comment` or `gh issue comment`.
- Replacement: call `gh` directly with `--body-file`.

### 14. Delete the unused toolchain-manifest wakeup parser

- Tag: `delete`
- Estimated reduction: 22 lines
- Path: `apps/core/src/jobs/toolchain-manifest-notify.ts:18`
- Evidence: `parseToolchainManifestWakeup` has no calls. The live listener uses
  the notification only as a wakeup signal and intentionally ignores payload
  content.
- Replacement: nothing.

### 15. Delete four abandoned test hooks

- Tag: `delete`
- Estimated reduction: 18 lines
- Paths and symbols:
  - `apps/core/src/memory/app-memory-recall-query.ts` —
    `_testMemoryRecallQuery`
  - `apps/core/src/memory/maintenance-queue.ts` —
    `resetMemoryMaintenanceQueueForTests`
  - `apps/core/src/runtime/browser-profile-sync.ts` —
    `_getBrowserProfileSyncForTest`
  - `apps/core/src/runtime/conversation-context.ts` —
    `_testConversationContext`
- Evidence: source and test searches found declarations only.
- Replacement: nothing.

### 16. Shrink the SDK job-list query serializer

- Tag: `shrink`
- Estimated reduction: 12 lines after replacement code
- Paths:
  - <code>packages/sdk/src/job-list-query.ts</code>
  - `packages/sdk/src/index.ts`
- Evidence: the serializer has one caller and duplicates `querySuffix`.
  Passing the input object directly is not equivalent because it changes
  empty-string omission, field ordering, and extra runtime-property handling.
- Replacement: explicitly map the six accepted fields into `querySuffix`.

### 17. Delete six empty future-extraction placeholders

- Tag: `yagni`
- Estimated reduction: 6 lines
- Paths:
  - <code>apps/core/src/runtime/host/README.md</code>
  - <code>apps/core/src/runtime/agent/README.md</code>
  - <code>apps/core/src/runtime/permissions/README.md</code>
  - <code>apps/core/src/runner/mcp/transport/README.md</code>
  - <code>apps/core/src/memory/persistence/README.md</code>
  - <code>apps/core/src/infrastructure/local-services/README.md</code>
- Evidence: every file is a one-line reservation for future extracted modules;
  no architecture check or consumer requires them.
- Replacement: create directories when implementations exist.

### 18. Remove five unused direct dependencies

- Tag: `delete`
- Estimated reduction: 5 manifest lines plus generated lockfile pruning
- Path: `package.json`
- Dependencies:
  - `@fastify/cors`
  - `@fastify/helmet`
  - `fastify`
  - `@langchain/anthropic`
  - `dayjs`
- Evidence: exact import, require, and dynamic-import searches found no runtime
  use. DeepAgents constructs only the supported OpenAI-compatible lane here;
  `dayjs` appears only as test fixture package-name data.
- Replacement: nothing.

### 19. Delete the obsolete post-tool hook stub

- Tag: `delete`
- Estimated reduction: 3 lines
- Path: `.codex/scripts/post_tool_use.py`
- Evidence: it is not configured, and the hook contract test explicitly asserts
  that it is absent from the configured hook surface.
- Replacement: nothing.

### 20. Delete the duplicate Postgres extension initializer

- Tag: `delete`
- Estimated reduction: 2 lines
- Path: `ops/postgres/init/001_extensions.sql`
- Evidence: Compose mounts the whole init directory, and
  `001-gantry-bootstrap.sh` already creates `vector` and `pg_trgm` before the
  SQL file repeats the same idempotent statements.
- Replacement: keep `ops/postgres/init/001-gantry-bootstrap.sh`.

## Explicit Retractions and Corrections

The following initial claims did not survive adversarial verification:

- Keep `@anthropic-ai/sdk`. It is a required peer dependency of
  `@anthropic-ai/claude-agent-sdk`, not an unused duplicate dependency.
- Keep the Stop hook in the high-confidence baseline. It is configured,
  documented, and contract-tested even though its current behavior is a
  deliberate no-op.
- Do not classify `apps/core/src/config/settings/settings-revision-legacy-bindings.ts`
  as dead code. It has a live production call and an explicit behavior test.
  Removing it is conditional on proving that no stored settings revision still
  needs the old shape.
- Do not classify <code>apps/core/src/jobs/job-plan-formatter.ts</code> as unused. It has a
  production consumer and tests. It remains only as a wrapper-removal finding.
- Do not replace `jobListQuery(input)` with `querySuffix(input ?? {})` directly;
  that changes observable serialization behavior. The corrected finding uses
  explicit field mapping and a smaller savings estimate.
- The original `net: -1427 lines, -6 deps` figure was not a defensible net
  calculation. The corrected total subtracts replacement code, removes overlap,
  and excludes retracted claims.

## Verification Performed

- Hidden-inclusive exact searches with `rg` and tracked-file searches with
  `git grep`.
- Semantic discovery with `ccc`.
- Structural TypeScript call searches with `ast-grep`.
- Import, namespace-import, dynamic-import, package-script, documentation, and
  generated-output searches.
- `npm explain` checks for dependency reason chains and peer dependencies.
- Local Git history inspection for migration and harness intent.
- Two independent subagent falsification passes plus a final overlap and
  arithmetic check.

No implementation, configuration, dependency, or Git changes were made as part
of the audit itself.
