# LAT-2 One Immutable Per-Turn Access Snapshot Plan

## Problem

The response-latency roadmap scopes LAT-2 to one immutable per-turn access
snapshot: load active tool bindings, enabled skills, and materialized MCP server
rows once per turn, then derive tool policy, selected-skill displays, skill
actions, semantic capability context, capability catalog, selected MCP source
ids, and provider-session access fingerprint from that value.

Current code has a coordinator named `resolveGroupAgentAccessContext(...)`, but
it is not yet the canonical snapshot. It still orchestrates several independent
repository reads:

- `resolveConfiguredToolPolicy(...)` loads active tool bindings, then calls
  `getTool(...)` per binding, separately calls `listEnabledSkillsForAgent`
  to decide skill-action projection, and the broad semantic context separately
  scans app-wide active tools.
- `resolveTurnSelectedSkillContext(...)`, `buildApprovedSkillContextBlock(...)`,
  `skillActionDefinitionsForAgent(...)`, and the prompt catalog each reload
  skill bindings or enabled skills.
- `resolveTurnSelectedMcpServerIds(...)`, the prompt catalog, `agent-spawn`, and
  `agent-inline` each have their own MCP materialization/listing path.
- Jobs, recovered async delegation, inline task-lifecycle runs, scheduler
  task-message policy, and delegation target resolution repeat the same access
  resolution for their execution owner.

Current-state contradictions the plan must preserve rather than hide:

- Broad `semanticCapabilities` includes all app-wide active semantic tool
  definitions plus usable skill actions. The prompt catalog `readyActions` uses
  selected/runtime-filtered semantic capabilities. These are intentionally
  different sets and must not be collapsed.
- Selected skill ids include every active skill binding even when the skill row
  is missing or not enabled; later selected-skill materialization fails closed.
  A snapshot that contains only enabled skills would silently change behavior.
- Attached MCP source ids include active bindings whose same-app server exists
  even if the server is inactive; materialized MCP server rows filter active
  servers. A snapshot that contains only materialized active MCP rows would
  silently change behavior.
- Phase 0 synthetic `get_skill_calls` models the latency fixture's fake artifact
  work. It must not be claimed as proof of real repository `getSkill(...)`
  fanout.

That defeats the Phase 2 latency goal and makes equivalence fragile: the turn can
derive model-visible and resume-fingerprint values from multiple reads instead
of one immutable value passed through the runtime.

Product model: an agent access snapshot is a read-only, per-turn projection of
the agent's current durable access authority. It grants nothing by itself. All
tool calls, skill use, MCP calls, permissions, sandbox rules, credential
projection, and audit checks remain enforced by their existing call-time
boundaries.

## Scope / Non-goals

In scope:

- Runtime hot-path access resolution for live turns, job execution, recovered
  delegated-agent runs, inline task lifecycle access, and direct inline agent
  execution.
- Final job readiness must evaluate tool policy, selected skill capabilities,
  and MCP source readiness from the same immutable access snapshot that the
  job runner will receive. Browser, credential, worker-registry, and runtime
  dependency readiness remain live checks at their existing boundaries.
- One repository read family each for tool access rows, skill access rows, and
  MCP access rows for a given `{ appId, agentId }`.
- Minimal hot-path access snapshot query methods that return raw active bindings
  plus nullable definitions needed for equivalence:
  - tools: active tool bindings plus nullable selected tool definitions and all
    app-wide active tool definitions in one SQL statement;
  - skills: active skill bindings plus nullable skill definitions/usable enabled
    rows in one SQL statement;
  - MCP: active MCP bindings plus nullable same-app server definitions and
    materialized active server rows in one SQL statement.
- Pure projectors from the immutable snapshot to the current runtime outputs:
  configured tool policy, selected skill ids/displays, approved skill context
  block, semantic capability definitions, capability catalog, attached MCP
  source ids, materialized MCP source records, selected MCP projection, and
  provider-session access fingerprint.
- Red-first operation-count tests and equivalence tests before any behavior
  change.
- Deleting duplicate production hot-path access callers only after searches show
  no remaining production users.
- One test-only validation prerequisite in
  `apps/core/test/e2e/brain-dream-review-notify.postgres.e2e.test.ts`: capture
  the review id created by the operation under test instead of rediscovering it
  from accumulated pending-review state. This does not change production
  behavior or LAT-2 authority semantics.

Non-goals:

- No schema migration, index change, settings change, public API change, SDK
  contract change, CLI change, or admin-tool behavior change.
- No durable grant model, permission policy, locked-preset, sandbox, credential,
  provider gateway, memory, replay, history, artifact, or provider-session
  semantics change.
- No cache, global singleton, warm resource pool, cross-turn reuse, or
  transaction-spanning DB snapshot.
- No catalog-status policy change for selected tool definitions. LAT-2 must preserve the
  current runtime behavior: active bindings are considered, missing/cross-app
  tool definitions are rejected or ignored exactly as today, and disabled/error
  catalog status is not newly filtered unless an accepted decision authorizes
  that policy change.
- No edits to Control API/admin inventory functions except tests/mocks needed to
  satisfy the repository interface. Admin list/get/revoke/request flows remain
  current and must not be deleted.

Allowed production write scope:

- `apps/core/src/domain/ports/repositories.ts`
- `apps/core/src/adapters/storage/postgres/repositories/tool-repository.postgres.ts`
- `apps/core/src/adapters/storage/postgres/repositories/skill-repository.postgres.ts`
- `apps/core/src/adapters/storage/postgres/repositories/mcp-server-repository.postgres.ts`
- `apps/core/src/runtime/group-agent-access-context.ts`
- `apps/core/src/runtime/group-run-context.ts`
- `apps/core/src/runtime/group-agent-runner.ts`
- `apps/core/src/runtime/agent-spawn-types.ts`
- `apps/core/src/runtime/session-resume-runtime.ts`
- `apps/core/src/runtime/agent-spawn.ts`
- `apps/core/src/runtime/agent-spawn-mcp-source-records.ts`
- `apps/core/src/runtime/agent-spawn-selected-skill-env.ts`
- `apps/core/src/runtime/agent-inline.ts`
- `apps/core/src/app/bootstrap/inline-agent-loop-tools.ts`
- `apps/core/src/app/bootstrap/inline-agent-task-lifecycle.ts`
- `apps/core/src/app/bootstrap/runtime-services-async-task-recovery.ts`
- `apps/core/src/jobs/execution.ts`
- `apps/core/src/jobs/execution-readiness.ts`
- `apps/core/src/jobs/capability-readiness.ts`
- `apps/core/src/jobs/capability-eligibility.ts`
- `apps/core/src/application/jobs/job-readiness-service.ts`
- `apps/core/src/application/jobs/job-tool-policy.ts`
- `apps/core/src/application/jobs/job-capability-requirements.ts`, only to move
  the semantic capability catalog resolver out of
  `job-readiness-service.ts` and preserve its existing architecture line budget
  without changing an allowlist.
- `apps/core/src/jobs/ipc-agent-delegation-target.ts`
- `apps/core/src/jobs/ipc-delegated-agent-execution.ts`
- `apps/core/src/jobs/ipc-agent-task-lifecycle-handlers.ts`
- `apps/core/src/application/agent-execution/agent-access-snapshot.ts`
- `apps/core/src/application/agent-execution/agent-execution-adapter.ts`
- `apps/core/src/application/capability-secrets/skill-secret-projection.ts`
- `apps/core/src/application/capability-secrets/mcp-secret-projection.ts`
- `apps/core/src/application/agents/agent-tool-runtime-rules.ts`
- `apps/core/src/application/agents/agent-capability-skill-actions.ts`
- `apps/core/src/application/agents/agent-prompt-capability-catalog.ts`
- `apps/core/src/application/mcp/mcp-authorized-servers.ts`
- `apps/core/src/application/mcp/mcp-server-service.ts`
- `apps/core/src/application/skills/selected-skill-projection.ts`
- `apps/core/src/adapters/llm/inline-lane-dispatcher.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/claude-skill-materializer.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/execution-adapter.ts`
- `apps/core/src/adapters/llm/deepagents-langchain/execution-adapter.ts`
- `apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts`
- `apps/core/src/adapters/llm/deepagents-langchain/skill-projection.ts`

Allowed test write scope:

- Focused unit tests beside the touched runtime/application/adapter seams.
- `apps/core/test/integration/domain-repositories.postgres.integration.test.ts`
- `apps/core/test/integration/mcp-server.postgres.integration.test.ts`
- A LAT-2 focused Postgres query-count integration test may be added only if it
  uses `apps/core/test/harness/response-latency-postgres.ts`.
- `apps/core/test/unit/runtime/group-agent-access-context.test.ts`
- `apps/core/test/unit/jobs/execution.test.ts`
- `apps/core/test/unit/application/job-readiness-service.test.ts`
- `apps/core/test/unit/jobs/capability-readiness.test.ts`
- `apps/core/test/unit/jobs/capability-eligibility.test.ts`
- `apps/core/test/e2e/brain-dream-review-notify.postgres.e2e.test.ts`, limited
  to making its created-review lookup independent of accumulated pending-review
  rows so the full Postgres validation gate is deterministic.

## Acceptance Criteria

- A red test fails on current code because resolving one execution owner's
  runtime access performs more than one tool/skill/MCP access row read and then
  repeats per-binding definition reads.
- A red test fails on current code because selected-skill projection or runner
  MCP projection performs a second repository read after the turn snapshot has
  already loaded that data.
- The final implementation performs exactly one tool access query, one skill
  access query, and one MCP access query for a normal execution owner snapshot.
  If a repository is absent, the corresponding value is empty or fails exactly
  as the current missing-repository path does.
- Final job readiness reuses the already loaded snapshot for inherited tool
  policy, selected skill capability ids, and materialized MCP server rows. It
  does not issue a second tool, skill-binding, MCP-binding, or MCP
  materialization read before spawning the runner, and readiness cannot observe
  a newer access revision than the runner snapshot.
- The final execution regression proves each canonical tool, skill, and MCP
  snapshot loader runs exactly once and that legacy tool-policy, skill-binding,
  MCP-binding, and MCP-materialization repository paths are not called again.
- The tool access query returns active binding rows plus nullable selected tool
  definitions and all app-wide active tool definitions in one SQL statement. It
  app-filters both joined selected tool rows and app-wide definitions, preserves
  binding order, preserves missing/cross-app behavior, and does not add a new
  catalog-status filter to selected bound tools.
- The skill access query returns active binding rows and nullable skill
  definitions/usable enabled rows in one SQL statement. Selected skill ids still
  come from active bindings, not only enabled definitions.
- The MCP access query returns active binding rows plus nullable same-app server
  definitions/materialized active rows in one SQL statement. Attached source ids
  still follow current same-app existence semantics, not only active
  materialized rows.
- The MCP access query preserves the prior newest-500 binding boundary for both
  aggregate projections before definition/status filtering. With 501 bindings
  where the newest binding is disabled, the snapshot exposes 499 active rows
  from the bounded newest-500 window rather than reaching back to the oldest
  binding or returning an unbounded set. The same regression pins
  `activeBindings` in descending binding-created order and
  `materializedServers` in server-name order.
- Snapshot-derived outputs are value-equivalent to current outputs for:
  `toolPolicyRules`, `runtimeAccess`, semantic capabilities, selected skill ids,
  selected skill displays, approved skill context block, attached MCP source ids,
  capability catalog digest/content, and provider-session access fingerprint.
- Provider session expiry still occurs when access projection, selected skills,
  MCP sources, semantic capability content, capability catalog digest, or locked
  preset changes.
- When `turnContext` is absent but `catalogScope` is present, the capability
  catalog still loads the scoped installed-skill and connected-MCP inventory
  that the pre-LAT-2 path exposed. Other turn-owned projections remain empty;
  the fallback must not invent a full turn context.
- Locked agents remain fail-closed and never receive acquire/admin guidance that
  the current locked-preset logic removes.
- MCP source inventory and reviewed action authority remain separate: connected
  MCP sources can be visible as inventory, while callable actions still require
  reviewed capability runtime access and call-time authorization.
- DeepAgents worker, DeepAgents inline, Anthropic worker, Anthropic inline, jobs,
  recovered async delegated-agent runs, inline task lifecycle access, scheduler
  task-message policy, and IPC delegation target resolution all use
  snapshot-derived values or repository-backed wrappers that are explicitly kept
  for non-hot-path/admin callers.
- Admin/control functions that inspect or mutate access state still call their
  existing services and are not routed through the per-turn snapshot.
- Cleanup searches show no remaining duplicate production hot-path callers to
  the old per-turn helper combination before any helper is deleted.
- The brain dream review notification E2E uses the review emitted by its own
  operation and remains correct when prior pending reviews exist.
- No new dependency is added.
- The decomposition records `user_facing: false`.

## Technical Approach

Recommendation: create one small snapshot loader and keep the rest as pure
projection. Do not add a cache. The snapshot is an immutable object created for
one execution owner and passed down the existing runtime call chain.

Current-state reconciliation:

- Existing skill and MCP materialized methods are useful downstream, but they
  are too narrow to be the canonical access snapshot because they drop stale
  active bindings and inactive-but-existing MCP sources that current runtime
  semantics still observe.
- Tools need a new one-statement access query because the current runtime uses
  active binding rows, per-binding nullable tool definitions, and app-wide active
  semantic tool definitions.
- Skills need a hot-path access query that preserves raw active bindings and
  nullable definitions while still exposing the enabled/usable rows needed by
  approved skill context and artifact projection.
- MCP needs a hot-path access query that preserves raw active bindings and
  nullable same-app server definitions while still exposing the active
  materialized rows needed by runner projection and credential/materialization
  services.
- The snapshot is not an MVCC-consistent database transaction. The accepted
  behavior is "one immutable value per turn after reads complete", not
  cross-table transaction isolation.

Implementation outline:

1. Add hot-path access query methods to the repository ports and Postgres
   adapters. Each method must execute one SQL statement for its surface:
   `listAgentToolAccessSnapshotRows(...)`,
   `listAgentSkillAccessSnapshotRows(...)`, and
   `listAgentMcpAccessSnapshotRows(...)` or equivalently named local methods.
   The tool SQL may use tagged UNION rows or aggregated subresults so selected
   binding rows and app-wide active semantic definitions travel in one
   statement. No schema/index change is authorized. If `EXPLAIN` or the Phase 0
   Postgres counter proves an index is required, raise a Forge contradiction
   instead of smuggling an index into LAT-2.
2. Introduce a runtime/application snapshot value with:
   raw active tool bindings plus nullable selected tool definitions and app-wide
   active tool definitions, raw active skill bindings plus nullable/enabled
   skill definitions, raw active MCP bindings plus nullable/materialized server
   definitions, access preset, and owner scope.
3. Split existing resolver logic into pure functions that accept snapshot rows:
   tool runtime policy, skill action definitions, selected skill context,
   approved skill context block, semantic capability list, MCP source ids,
   prompt capability catalog, selected-skill projection validation, and
   provider-session access fingerprint.
4. Update `resolveGroupAgentAccessContext(...)` to load the three materialized
   surfaces once and return all existing fields plus the snapshot rows needed by
   runner/adapters.
5. Replace the separate `buildApprovedSkillContextBlock(...)` hot-path call in
   `group-agent-runner.ts` with the snapshot-derived approved skill block.
6. Pass only host-owned preloaded skill and MCP rows through a typed
   `RunAgentOptions` carrier in `agent-spawn-types.ts` and adapter preparation
   options, not through environment variables or model-visible `AgentInput`.
   Split selected-skill projection through `agent-spawn-selected-skill-env.ts`,
   skill-secret projection, MCP credential projection, and MCP materialization
   service entrypoints so they can consume preloaded rows and avoid rereading the
   same turn access rows. Keep artifact reads for selected skill files,
   capability-secret lookups, and remote MCP connect/list-tools out of scope
   because those are different materialization boundaries.
7. Update job execution, recovered async delegated-agent runs, inline task
   lifecycle access, scheduler task-message policy, and IPC delegation target
   resolution to call the same snapshot loader for the execution owner or to use
   repository-backed wrappers explicitly kept for non-hot-path/admin callers.
   Preserve current caller-policy reuse in delegation when target equals caller.
8. After all production callers are moved, delete or narrow only the duplicate
   hot-path helpers that have no remaining production users. Do not delete
   admin/control/review helper functions.
9. Pass the already resolved snapshot projections into the final job-readiness
   call. Reuse its tool policy, selected active skill bindings for fleet
   capability requirements, and materialized MCP rows while retaining live
   checks for credentials, browser state, runtime dependencies, and active
   worker inventory. The execution regression must assert the three canonical
   snapshot loaders each run once and all legacy tool, skill-binding,
   MCP-binding, and MCP-materialization readers remain unused after that load.
   Repository-backed readiness callers that do not already own a snapshot keep
   their existing behavior.
10. Apply the historical newest-500 MCP binding window inside the one-statement
    snapshot query before both active-binding and materialized-server
    projections filter rows. Add a 501-binding Postgres regression with the
    newest binding disabled; assert descending binding-created order for
    `activeBindings` and server-name order for `materializedServers`.
11. When only `catalogScope` is available, load one scoped snapshot solely for
    capability-catalog inventory instead of projecting a synthetic empty
    catalog. Preserve empty turn-owned policy, selection, MCP attachment, and
    semantic projections on that fallback path.

Rejected simpler approach:

- Keeping the existing helpers and just wrapping them in `Promise.all` is not
  enough; the latency problem is duplicate repository reads, not only serial
  scheduling.
- Adding an in-memory cache is broader and riskier than passing one immutable
  per-turn value. It would introduce invalidation and cross-turn authority risk
  the phase does not need.

Rejected broader approach:

- A DB transaction or cross-table MVCC snapshot is not authorized by LAT-2. It
  would change consistency semantics and potentially hold resources longer on
  the hot path.
- Filtering disabled/error tool catalog rows would be a behavior/security policy
  change, not a latency refactor. Keep current semantics unless a later decision
  changes them.

## Decisions

- `docs/decisions/0071-client-signoff.md` records the accepted LAT-2 client
  signoff, bounded phase scope, red-first operation-count requirement, durable
  authority invariants, and explicit non-goals.
- No new technical decisions. The plan uses existing accepted decisions:
  provider-neutral execution, MCP source-vs-action authority, locked preset
  fail-closed behavior, settings authority, and early-stage clean deletion.

## Surface Impact

| Surface | Status | Reason |
|---|---|---|
| Runtime behavior | Changed | Runtime derives per-turn access projections from one immutable snapshot instead of duplicate reads. User-visible authority and call-time checks are unchanged. |
| API | Unchanged by design | No Control API, SDK, webhook, or public route contract changes. |
| Data/schema | Unchanged by design | Adds a repository query method only; no table, migration, data shape, or index change unless a contradiction is raised. |
| CLI/ops | Unchanged by design | No CLI commands, settings, deployment knobs, or admin workflows change. |
| UI | N-A | No user-facing UI or channel copy change. |
| Docs | Changed | Adds LAT-2 signoff, plan, decomposition, and local session-state notes. |
| Tests | Changed | Adds red-first operation-count/equivalence tests, repository query tests, and focused runtime/adapter regression coverage. |

## Task Decomposition

Stage `LAT-2-RED-COUNTS-EQUIVALENCE`

- Objective: prove the current duplicate-read behavior before production edits.
- Write scope:
  - `apps/core/test/unit/runtime/group-agent-access-context.test.ts`
  - `apps/core/test/unit/runtime/group-processing.test.ts`
  - `apps/core/test/unit/runtime/agent-spawn.test.ts`
  - `apps/core/test/unit/runtime/agent-inline.test.ts`
  - `apps/core/test/unit/application/selected-skill-projection.test.ts`
  - `apps/core/test/unit/application/agent-prompt-capability-catalog.test.ts`
- Acceptance criteria:
  - Tests fail against current code for operation counts on tools, skills, and
    MCP access materialization.
  - Tests use behavior-level expected values, not implementation-coupled
    snapshots of private helper calls.
  - Equivalence fixtures cover selected skill metadata, skill action
    capabilities, MCP inventory-only source visibility, reviewed MCP action
    authority, locked preset, and provider-session fingerprint digest changes.
- Reviewer focus: tests would fail for duplicate hot-path reads and for any
  authority drift, not just for renamed functions.

Stage `LAT-2-MATERIALIZED-TOOLS-AND-SNAPSHOT`

- Objective: add the three one-statement access snapshot queries and immutable
  snapshot projectors.
- Write scope:
  - `apps/core/src/domain/ports/repositories.ts`
  - `apps/core/src/adapters/storage/postgres/repositories/tool-repository.postgres.ts`
  - `apps/core/src/adapters/storage/postgres/repositories/skill-repository.postgres.ts`
  - `apps/core/src/adapters/storage/postgres/repositories/mcp-server-repository.postgres.ts`
  - `apps/core/src/runtime/group-agent-access-context.ts`
  - `apps/core/src/runtime/group-run-context.ts`
  - `apps/core/src/runtime/session-resume-runtime.ts`
  - `apps/core/src/application/agents/agent-tool-runtime-rules.ts`
  - `apps/core/src/application/agents/agent-capability-skill-actions.ts`
  - `apps/core/src/application/agents/agent-prompt-capability-catalog.ts`
  - `apps/core/src/application/mcp/mcp-authorized-servers.ts`
  - focused tests for these files
- Dependencies:
  - `LAT-2-RED-COUNTS-EQUIVALENCE`
- Acceptance criteria:
  - Tool access query is one SQL statement, no schema/index change, no
    selected-tool catalog-status policy change, app-filtered on both joined
    selected rows and app-wide definitions, and binding-order preserving.
  - Skill access query is one SQL statement and keeps active binding ids even
    when definitions are missing or disabled so later materialization can fail
    closed.
  - MCP access query is one SQL statement and keeps active binding ids whose
    same-app server exists even when the server is not active, while also
    exposing active materialized rows for runner projection.
  - Snapshot loader performs one tool access call, one skill access call, and
    one MCP access call per owner.
  - Snapshot projectors produce the same runtime values as current helpers.
- Reviewer focus: no hidden cache, no fallback duplicate production reads, no
  weakened missing/cross-app validation.

Stage `LAT-2-WIRE-RUNTIME-CONSUMERS`

- Objective: pass snapshot-derived values through every runtime execution path
  that currently repeats per-turn access reads.
- Write scope:
  - `apps/core/src/runtime/group-agent-runner.ts`
  - `apps/core/src/runtime/agent-spawn-types.ts`
  - `apps/core/src/runtime/agent-spawn.ts`
  - `apps/core/src/runtime/agent-spawn-mcp-source-records.ts`
  - `apps/core/src/runtime/agent-spawn-selected-skill-env.ts`
  - `apps/core/src/runtime/agent-inline.ts`
  - `apps/core/src/app/bootstrap/inline-agent-loop-tools.ts`
  - `apps/core/src/app/bootstrap/inline-agent-task-lifecycle.ts`
  - `apps/core/src/app/bootstrap/runtime-services-async-task-recovery.ts`
  - `apps/core/src/jobs/execution.ts`
  - `apps/core/src/jobs/ipc-agent-delegation-target.ts`
  - `apps/core/src/jobs/ipc-delegated-agent-execution.ts`
  - `apps/core/src/jobs/ipc-agent-task-lifecycle-handlers.ts`
  - `apps/core/src/application/agent-execution/agent-access-snapshot.ts`
  - `apps/core/src/application/agent-execution/agent-execution-adapter.ts`
  - `apps/core/src/application/skills/selected-skill-projection.ts`
  - `apps/core/src/application/capability-secrets/skill-secret-projection.ts`
  - `apps/core/src/application/capability-secrets/mcp-secret-projection.ts`
  - `apps/core/src/application/mcp/mcp-server-service.ts`
  - `apps/core/src/adapters/llm/inline-lane-dispatcher.ts`
  - `apps/core/src/adapters/llm/anthropic-claude-agent/claude-skill-materializer.ts`
  - `apps/core/src/adapters/llm/anthropic-claude-agent/execution-adapter.ts`
  - `apps/core/src/adapters/llm/deepagents-langchain/execution-adapter.ts`
  - `apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts`
  - `apps/core/src/adapters/llm/deepagents-langchain/skill-projection.ts`
  - focused tests for these files
- Dependencies:
  - `LAT-2-MATERIALIZED-TOOLS-AND-SNAPSHOT`
- Acceptance criteria:
  - Main turns, jobs, recovered async delegation, IPC delegation target and
    delegated-agent execution, inline task lifecycle access and delegated-agent
    execution, scheduler task-message policy, Anthropic worker/inline, and
    DeepAgents worker/inline all consume one snapshot-derived skill and MCP row
    set where they previously reloaded access.
  - `task_message` policy in `ipc-agent-task-lifecycle-handlers.ts` uses
    snapshot-derived policy for the execution owner and has focused test
    coverage.
  - Selected-skill artifact loading and MCP credential/remote connection work
    still happen at their existing boundaries and are not claimed as eliminated
    access reads.
  - Provider-session access fingerprint and DeepAgents prompt-cache access
    partitioning still change when the catalog digest or access projection
    changes.
- Reviewer focus: adapter contracts remain provider-neutral and no provider- or
  channel-specific logic leaks into domain/application code.

Stage `LAT-2-CLEANUP-VERIFY`

- Objective: delete duplicate hot-path access callers only when unused and
  record deterministic proof.
- Write scope:
  - duplicate helper imports/callers in production files already touched by this
    plan
  - `apps/core/test/e2e/brain-dream-review-notify.postgres.e2e.test.ts`
  - `.factory/tests.json` through `record_test_from_json.py`
- Dependencies:
  - `LAT-2-WIRE-RUNTIME-CONSUMERS`
- Acceptance criteria:
  - Cleanup searches show no remaining production hot-path calls to the old
    duplicate helper combination.
  - Admin/control/review functions that use list/get repository methods remain.
  - The brain dream review notification E2E captures the review created by the
    current operation and passes when the database contains prior pending
    reviews, without changing production code.
  - Focused unit tests, Postgres integration query-count proof, architecture
    check, typecheck, and deterministic verify are recorded with exact output or
    exact blockers.
- Reviewer focus: no accidental deletion of admin surfaces, no skipped blocker
  reported as green.

Stage `LAT-2-AUTOREVIEW-FIXES`

- Objective: close the three bounded final-autoreview regressions without
  widening LAT-2 into a general readiness or catalog redesign.
- Write scope:
  - `apps/core/src/jobs/execution.ts`
  - `apps/core/src/jobs/execution-readiness.ts`
  - `apps/core/src/application/jobs/job-readiness-service.ts`
  - `apps/core/src/application/jobs/job-tool-policy.ts`
  - `apps/core/src/application/jobs/job-capability-requirements.ts`, limited to
    moving the semantic capability catalog resolver so
    `job-readiness-service.ts` remains within its existing line budget without
    an architecture allowlist change
  - `apps/core/src/jobs/capability-readiness.ts`
  - `apps/core/src/jobs/capability-eligibility.ts`
  - `apps/core/src/adapters/storage/postgres/repositories/mcp-server-repository.postgres.ts`
  - `apps/core/src/runtime/group-agent-access-context.ts`
  - `apps/core/test/unit/jobs/execution.test.ts`
  - `apps/core/test/unit/application/job-readiness-service.test.ts`
  - `apps/core/test/unit/jobs/capability-readiness.test.ts`
  - `apps/core/test/unit/jobs/capability-eligibility.test.ts`
  - `apps/core/test/unit/runtime/group-agent-access-context.test.ts`
  - `apps/core/test/integration/mcp-server.postgres.integration.test.ts`
- Dependencies:
  - `LAT-2-CLEANUP-VERIFY`
- Acceptance criteria:
  - Final job readiness consumes the same snapshot-derived tool policy, selected
    skill bindings, and materialized MCP rows passed to the runner, while
    non-access readiness remains live.
  - A focused final execution regression proves each canonical tool, skill, and
    MCP snapshot loader runs exactly once and no legacy tool-policy,
    skill-binding, MCP-binding, or MCP-materialization read occurs after
    snapshot load.
  - A 501-binding Postgres regression proves the newest-500 boundary is applied
    before filtering to both MCP snapshot aggregates, preserves
    `activeBindings` descending binding-created order, and preserves
    `materializedServers` server-name order.
  - A catalog-only regression proves missing `turnContext` still projects
    installed skills and connected MCP sources for `catalogScope` without
    populating turn-owned access fields.
- Reviewer focus: preserve one per-turn authority view, the historical MCP
  boundary, and the degraded catalog fallback without adding cache or changing
  public contracts.

## Risks

- The tool materialized join could accidentally filter tool catalog status and
  change authorization behavior. Mitigation: preserve current semantics and add
  an equivalence test where active binding plus non-active catalog status behaves
  as current code does.
- The snapshot could be mistaken for a DB transaction. Mitigation: document and
  test only immutable in-memory values after the three reads complete; do not
  claim MVCC consistency.
- Passing snapshot rows through adapter inputs could widen provider contracts.
  Mitigation: keep rows as Gantry runtime access projection data, not provider
  SDK payloads, and keep provider-specific materialization behind adapters.
- A fallback path could silently keep duplicate reads in production. Mitigation:
  operation-count tests fail when the old repository methods are called after
  snapshot load.
- Admin and review paths need list/get methods for management workflows.
  Mitigation: cleanup searches distinguish runtime hot-path callers from
  admin/control callers; delete only duplicate hot-path callers after no
  remaining production users.
- Query performance may require an index. Mitigation: LAT-2 does not add schema
  changes. If Phase 0 `measurePostgresOperations` or `EXPLAIN` proves the join
  needs a new index, raise a Forge contradiction and stop for a schema decision.
- Bare `./forge` still resolves `/usr/bin/python3` 3.9.6 and fails the harness
  Python check. Mitigation: use `/opt/homebrew/bin/python3
  .agents/scripts/forge.py ...` in this worktree and keep the mismatch recorded
  in `@session-state.md`.
- Final readiness can accidentally mix snapshot access with newer repository
  state. Mitigation: inject only the already-derived access inputs while
  retaining explicitly non-access live probes, and assert no duplicate access
  repository calls.
- Limiting after filtering would silently backfill older MCP bindings.
  Mitigation: bound the newest 500 bindings first, then project active and
  materialized rows from that same window.
- Loading a full fallback snapshot from `catalogScope` could populate
  turn-owned access fields that were previously empty. Mitigation: use the
  fallback snapshot only for capability-catalog inventory and pin the other
  fields in a focused unit test.
- Moving the semantic catalog resolver solely to satisfy the existing
  `job-readiness-service.ts` line budget could become an unrelated refactor.
  Mitigation: keep the move in `job-capability-requirements.ts`, preserve the
  function contract byte-for-byte, and do not change architecture allowlists.

## Verify Plan

Red phase:

```bash
npm run test:unit -- apps/core/test/unit/runtime/group-agent-access-context.test.ts apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/runtime/agent-spawn.test.ts apps/core/test/unit/runtime/agent-inline.test.ts apps/core/test/unit/application/selected-skill-projection.test.ts apps/core/test/unit/application/agent-prompt-capability-catalog.test.ts
```

Focused implementation proof:

```bash
npm run test:unit -- apps/core/test/unit/runtime/group-agent-access-context.test.ts apps/core/test/unit/runtime/group-processing.test.ts apps/core/test/unit/runtime/agent-spawn.test.ts apps/core/test/unit/runtime/agent-inline.test.ts apps/core/test/unit/bootstrap/runtime-services.test.ts apps/core/test/unit/jobs/execution.test.ts apps/core/test/unit/adapters/anthropic-execution-adapter.test.ts apps/core/test/unit/adapters/deepagents-execution-adapter.test.ts apps/core/test/unit/adapters/deepagents-inline-lane.test.ts apps/core/test/unit/application/agent-prompt-capability-catalog.test.ts apps/core/test/unit/application/selected-skill-projection.test.ts apps/core/test/unit/application/agent-tool-runtime-rules.test.ts
npm run test:integration:postgres -- apps/core/test/integration/domain-repositories.postgres.integration.test.ts apps/core/test/integration/response-latency-postgres.postgres.integration.test.ts
```

The Postgres proof must use `measurePostgresOperations(...)` from
`apps/core/test/harness/response-latency-postgres.ts` to show one tool access
query, one skill access query, and one MCP access query for the LAT-2 snapshot
path. Do not use the Phase 0 synthetic `get_skill_calls` counter as evidence of
real repository `getSkill(...)` fanout. Missing `GANTRY_TEST_DATABASE_URL` is a
blocker for Postgres-backed proof, not a pass.

Cleanup searches:

```bash
rg -n "resolveTurnToolPolicy|resolveTurnSelectedSkillContext|resolveTurnSemanticCapabilities|resolveTurnSelectedMcpServerIds|buildApprovedSkillContextBlock|listAgentToolBindings\\(|getTool\\(|listAgentSkillBindings\\(|getSkill\\(|listAgentBindings\\(|getServer\\(|listEnabledSkillsForAgent\\(|listMaterializedServersForAgent\\(" apps/core/src/runtime apps/core/src/app/bootstrap apps/core/src/jobs apps/core/src/adapters/llm apps/core/src/application/skills apps/core/src/application/agents apps/core/src/application/mcp -S
```

Expected interpretation: production runtime hot-path callers should route
through the snapshot. Admin/control/review services, repository implementations,
tests, and explicitly non-hot-path management flows may still use list/get
methods.

Gate checks:

```bash
npm run format:check
npm run typecheck
npm run check:architecture
/opt/homebrew/bin/python3 .agents/scripts/verify.py
scripts/agent-job-smoke.sh job-knacklabs-lead-maintenance-43527c192a6e --timeout-sec 900
```

Implementation must record automated test evidence through
`record_test_from_json.py`. Review remains one branch-wide autoreview pass with
quality, performance, and security artifacts; no inline or nested review.
