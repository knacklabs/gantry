Read-only audit completed; no files changed. Seven findings follow. Ordinary local Postgres skips are explicitly permitted; the routing gaps below affect configured CI lanes.

1. **Database tests stranded outside PR checks — kind: over-complicated**

   Developers can get green PR checks without running seven database-backed suites. CI runs ordinary integration tests before exporting the database URL, then selects the restricted Postgres lane. See [ci.yml:157](../../../../.github/workflows/ci.yml#L157).

   **Locations:** explicit exclusions at [vitest.integration.postgres.config.ts:31](../../../../vitest.integration.postgres.config.ts#L31) omit [pattern-candidate-atomic-claim:57](../../../../apps/core/test/integration/pattern-candidate-atomic-claim.postgres.integration.test.ts#L57), [toolchain-bake-reconciler:104](../../../../apps/core/test/integration/toolchain-bake-reconciler.postgres.integration.test.ts#L104), and [worker-coordination:271](../../../../apps/core/test/integration/worker-coordination.postgres.integration.test.ts#L271).

   The filename selector at [config:21](../../../../vitest.integration.postgres.config.ts#L21) also misses DB-gated [browser-profile-snapshot:24](../../../../apps/core/test/integration/browser-profile-snapshot.integration.test.ts#L24), [live-horizontal-execution:25](../../../../apps/core/test/integration/live-horizontal-execution.integration.test.ts#L25), [scheduler-trigger-non-executing-role:35](../../../../apps/core/test/integration/scheduler-trigger-non-executing-role.integration.test.ts#L35), and the database section of [inline-agent-runtime:1019](../../../../apps/core/test/integration/inline-agent-runtime.integration.test.ts#L1019).

   **Survive:** naming-based selection and intentional chaos/hot-path lanes. **Delete/merge:** remove the historical exclusions; adopt or split the four misnamed suites. **Size:** medium story. **Risk:** newly exercised tests may reveal existing failures; this audit does not establish that they pass.

2. **“Hermetic” selection strands a real-model scenario — kind: parallel**

   Nightly selects both real-model suites through the hermetic glob, where they skip without credentials. The credentialed step subsequently selects only Haiku, leaving coordinator-authority unexecuted.

   **Locations:** [agent config:7](../../../../vitest.agent-e2e.config.ts#L7); credential gates in [coordinator-authority:22](../../../../apps/core/test/agent-e2e/scenarios/coordinator-authority.agent-e2e.test.ts#L22) and [haiku-turn:42](../../../../apps/core/test/agent-e2e/scenarios/haiku-turn.agent-e2e.test.ts#L42); Haiku-only selection at [package.json:95](../../../../package.json#L95); credential placement at [nightly-e2e.yml:118](../../../../.github/workflows/nightly-e2e.yml#L118).

   **Survive:** separate hermetic and supplementary real-model lanes. **Delete/merge:** remove real-model files from hermetic selection and route both through the credentialed command. **Size:** small, three files. **Risk:** additional model time and cost. The existing skip notices are explicit; the problem is selection.

3. **Authentication security checks assert source spelling — kind: over-complicated**

   Harmless renames break a test advertised as proving atomic consumption and administrator locking. Conversely, the required strings can remain while their placement or predicates become wrong.

   **Locations:** [authentication unit test:99](../../../../apps/core/test/unit/auth/authentication-repository.test.ts#L99) inspects [repository:86](../../../../apps/core/src/adapters/storage/postgres/repositories/authentication-repository.postgres.ts#L86), [repository:151](../../../../apps/core/src/adapters/storage/postgres/repositories/authentication-repository.postgres.ts#L151), and [repository:647](../../../../apps/core/src/adapters/storage/postgres/repositories/authentication-repository.postgres.ts#L647).

   **Survive:** real concurrent one-use consumption at [Postgres test:55](../../../../apps/core/test/integration/authentication-repository.postgres.integration.test.ts#L55) and expired-transaction deletion at [Postgres test:93](../../../../apps/core/test/integration/authentication-repository.postgres.integration.test.ts#L93). **Delete/merge:** remove the source inventory; move independently needed security assertions to database behaviour tests. **Size:** small. **Risk:** administrator-locking coverage needs replacement before deleting its string assertions.

4. **Backlog test preserves a production-only-for-tests wrapper — kind: over-complicated**

   A test named “counts queued and due-deferred” supplies `{waiting: true}` itself, then checks a SQL substring. It exercises neither row classification nor scheduler behaviour.

   **Locations:** [scheduler-trigger-queue.test.ts:138](../../../../apps/core/test/unit/jobs/scheduler-trigger-queue.test.ts#L138); forwarding export at [scheduler.ts:261](../../../../apps/core/src/jobs/scheduler.ts#L261). That export’s only caller is this test. Production instead wires the private query at [scheduler.ts:180](../../../../apps/core/src/jobs/scheduler.ts#L180).

   **Survive:** the private query and scheduler deferral behaviour at [scheduler-engine.ts:474](../../../../apps/core/src/infrastructure/pgboss/scheduler-engine.ts#L474). **Delete/merge:** replace the mock/string test with queued, due-deferred, and future-deferred rows exercised through scheduler admission; delete the wrapper. **Size:** small. **Risk:** retain real chat-priority coverage.

5. **Two ZIP fixture encoders have drifted — kind: duplicate**

   Fixture changes require maintaining two implementations of local headers, central-directory records, and end records. Only one supports compression and dishonest declared sizes.

   **Every copy:** [test-skill-zip.ts:1](../../../../apps/core/test/harness/test-skill-zip.ts#L1), [skill-zip-upload.test.ts:110](../../../../apps/core/test/unit/control/skill-zip-upload.test.ts#L110). Integration consumers start at [skills-registry-flow:347](../../../../apps/core/test/integration/skills-registry-flow.integration.test.ts#L347).

   **Survive:** one shared encoder with the compression/malformed-size controls needed by parser tests. **Delete/merge:** consolidate both builders, preserving existing cases. **Size:** small, three files. **Risk:** preserve malformed-archive security coverage. The redundant shared copy is 65 lines.

6. **Eight integration suites hand-roll schema lifecycle — kind: duplicate**

   Developers maintain repeated naming, migration, drop, and close code. These copies close the service after dropping the schema; the shared harness closes it in `finally`.

   **Every copy:** [pending-access:34](../../../../apps/core/test/integration/pending-access-requests.postgres.integration.test.ts#L34), [proactive-surfacing:24](../../../../apps/core/test/integration/proactive-surfacing-opt-in.postgres.integration.test.ts#L24), [fleet-capability-state:26](../../../../apps/core/test/integration/fleet-capability-state-repositories.postgres.integration.test.ts#L26), [domain-repositories:90](../../../../apps/core/test/integration/domain-repositories.postgres.integration.test.ts#L90), [authentication:18](../../../../apps/core/test/integration/authentication-repository.postgres.integration.test.ts#L18), [browser-profile:41](../../../../apps/core/test/integration/browser-profile-snapshot.integration.test.ts#L41), [toolchain-bake:81](../../../../apps/core/test/integration/toolchain-bake-reconciler.postgres.integration.test.ts#L81), [migration-chain:27](../../../../apps/core/test/integration/postgres-migration-chain.postgres.integration.test.ts#L27).

   **Survive:** [shared Postgres harness:53](../../../../apps/core/test/harness/postgres-integration-runtime.ts#L53). **Delete/merge:** reuse its lifecycle, retaining suite-specific setup and the migration test’s explicit rerun. **Size:** medium story. **Risk:** preserve schema isolation; shared setup also creates artifacts these simpler suites currently avoid.

7. **Digest settlement is replayed across layers — kind: duplicate**

   Developers maintain mocked settlement checks alongside stronger persisted outcomes.

   **Every overlapping case:** unit [durable-send:725](../../../../apps/core/test/unit/brain/observer-digest.test.ts#L725) and [pending-send:761](../../../../apps/core/test/unit/brain/observer-digest.test.ts#L761); integration [cooldown:102](../../../../apps/core/test/integration/observer-digest.postgres.integration.test.ts#L102) and [retry:225](../../../../apps/core/test/integration/observer-digest.postgres.integration.test.ts#L225).

   **Survive:** Postgres reservation/claim/cooldown outcomes and distinct pure-rule tests. **Delete/merge:** move useful gateway-payload assertions into integration, then delete the two overlapping unit cases. **Size:** small, two files. **Risk:** preserve route, idempotency-key, and cooldown assertions.

The slowest **documented lane** is E2E ([nightly workflow:5](../../../../.github/workflows/nightly-e2e.yml#L5)); current per-suite rankings are unknown. Packaged-runtime suites create databases/extensions ([harness:175](../../../../apps/core/test/agent-e2e/harness/runtime-harness.ts#L175)), spawn migration/runtime processes ([harness:341](../../../../apps/core/test/agent-e2e/harness/runtime-harness.ts#L341)), and poll readiness every 500 ms ([harness:227](../../../../apps/core/test/agent-e2e/harness/runtime-harness.ts#L227)), serially. Haiku additionally waits on a real model ([test:190](../../../../apps/core/test/agent-e2e/scenarios/haiku-turn.agent-e2e.test.ts#L190)). DeepAgents integration repeatedly sets up checkpoints and spawns the TSX runner ([test:474](../../../../apps/core/test/integration/deepagents-langchain-boundary.postgres.integration.test.ts#L474)). These costs alone do not justify deletion.

covered by PERMFLOW-1..4: batch permission callback tests, including [worker-coordination:1842](../../../../apps/core/test/integration/worker-coordination.postgres.integration.test.ts#L1842).

covered by planned progress-card Stop deletion: Stop-affordance coverage in [Telegram:1156](../../../../apps/core/test/unit/channels/telegram.test.ts#L1156), [Slack:4765](../../../../apps/core/test/unit/channels/slack.test.ts#L4765), and [progress sender:694](../../../../apps/core/test/unit/runtime/group-progress-channel-sender.test.ts#L694).

Ranked value, prioritizing user protection before deletion:

1. Database routing gaps.
2. Stranded coordinator-authority scenario.
3. Authentication behaviour proof.
4. Scheduler backlog proof.
5. Shared schema lifecycle.
6. Shared ZIP encoder.
7. Digest test consolidation.
