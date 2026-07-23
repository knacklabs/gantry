# Review of PR #238 E2E Tests

Commit: `5a03dcc37`

## Findings

1. **[P1] (confidence: 10/10) `apps/core/test/integration/permission-durable-authority.postgres.integration.test.ts:276` — the allow-once case never proves that once-only authority works.**

   `makeRequest` supplies no run or lease, and the test then asserts that there is no transient grant (`:304-308`) and that the command is denied after a service reload (`:310-313`). On this path `applyPendingInteractionGrantDecision` returns success without granting anything when `runId` is absent (`apps/core/src/application/interactions/pending-interaction-grants.ts:64-77`). If the live IPC path stopped resuming/authorizing the current tool call after `allow_once`, this test would still pass: it proves only that the durable row says `approved`, not that the operation ran once. This does not support the matrix claim at `docs/architecture/agent-e2e-test-matrix.md:104` that Allow ONCE “runs, then authority expires after restart.”

2. **[P1] (confidence: 10/10) `apps/core/test/integration/permission-durable-authority.postgres.integration.test.ts:66` — the “survives restart” assertion bypasses the real desired-state persistence and restart reconciliation.**

   The test replaces `mirrorAgentToolRulesToSettings` with an in-memory call recorder (`:66-73`). Its restart helper only opens a second `PostgresStorageService` on the same schema and reads the already-written binding (`:148-177`, `:270-273`). Production persistent approval awaits the settings mirror, which appends/synchronizes desired state (`apps/core/src/config/settings/agent-tool-rule-settings-mirror.ts:16-46`), and startup can replace agent capability bindings from authoritative settings (`apps/core/src/app/bootstrap/startup.ts:129-145`, `apps/core/src/config/settings/desired-state-capability-reconcile.ts:79-106`). If the real mirror stopped writing a settings revision, or restart reconciliation dropped the DB-only binding, this test would remain green. It proves repository-row durability, not production restart survival.

3. **[P1] (confidence: 9/10) `apps/core/test/integration/permission-durable-authority.postgres.integration.test.ts:194` — the test does not prove the claimed agent scope.**

   Every binding lookup and policy evaluation uses the same `AGENT_ID` (`:196-227`, `:165-169`); no second agent is created or evaluated. If `resolveConfiguredAllowedTools` or the repository query regressed from `(appId, agentId)` filtering to app-wide filtering, the tested agent would still see the rule and every assertion would pass. The current agent-isolation predicate is at `apps/core/src/adapters/storage/postgres/repositories/tool-repository.postgres.ts:198-219`, but this test does not guard it. The matrix claim at `docs/architecture/agent-e2e-test-matrix.md:105` therefore overstates the evidence.

4. **[P2] (confidence: 10/10) `apps/core/test/integration/permission-durable-authority.postgres.integration.test.ts:229` — the negative assertion does not distinguish argv-leaf authority from an executable-wide rule.**

   The test only checks that `/usr/local/bin/other-tool --daily` is denied (`:231-237`), while the generated rule is asserted only to start with `RunCommand(` (`:183-186`). A regression that widens the persisted rule to `RunCommand(/usr/local/bin/report-status *)` would still allow the original command, deny `other-tool`, and pass the entire test, despite violating the asserted argv-leaf scope. The negative case must keep the executable fixed and change its arguments (for example, `report-status --monthly`), or assert the exact rule derived from the test input.

5. **[P2] (confidence: 10/10) `apps/core/test/integration/permission-durable-authority.postgres.integration.test.ts:203` — the test freezes a seed-data count instead of asserting the permission invariant.**

   `expect(activeBindings).toHaveLength(1)` depends on the current seed having zero pre-existing tool bindings, as the comment at `:31-32` explicitly states. Adding an unrelated default capability would break this test even if persistent approval remained correct. That is the change-detector pattern prohibited by `docs/architecture/agent-e2e-test-matrix.md:21-26`. Assert that exactly one active binding references the newly created `expectedRule`, or compare the relevant binding set before and after the decision, without fixing the total seeded binding count.
