# DeepAgents Decoupling Goal Prompt

> Status: superseded by implementation (2026-06-12). The per-agent agent-engine
> decoupling described here shipped on `feature/deepagents-agent-engine`. For the
> current contract see `docs/decisions/2026-06-12-agent-engine-selection.md`,
> `docs/decisions/2026-05-01-model-catalog-and-cache-accounting.md`, and
> `docs/architecture/deepagents-agent-engine-handoff-plan.md`. This prompt is kept
> as the historical goal record; do not treat it as current guidance.

Use this prompt after the citation-backed harness plan has been reviewed. It is
for the implementation phase that makes Gantry's current Anthropic SDK runtime
neutral enough to add DeepAgents as another harness.

```text
/goal Decouple Gantry's active agent execution runtime from Anthropic Claude Agent SDK assumptions so DeepAgents/LangChain can be added next as `deepagents:langchain` without leaking DeepAgents, Claude, Anthropic SDK, provider-native tools, provider sessions, or raw filesystem/shell authority into Gantry's public contracts.

This is an implementation goal. Make code, test, and docs changes as needed, but do not enable DeepAgents as a runnable production harness in this goal unless every decoupling acceptance criterion below is already satisfied and verified. The primary outcome is a clean provider-neutral harness boundary with the existing `anthropic:claude-agent-sdk` lane still working.

Current architectural decision:
- Gantry remains authoritative for tools, permissions, capabilities, MCP bindings, skills, browser, sandbox, sessions, jobs, settings, audit, memory, and dreaming.
- `anthropic:claude-agent-sdk` remains the native Claude OAuth/subscription lane.
- `deepagents:langchain` is the user-selectable API-key engine lane for supported OpenAI endpoint, Anthropic endpoint, and future LangChain-compatible provider routes.
- Harness-specific tool names, callback types, settings files, skill formats, MCP config shapes, session ids, and backend tools are adapter-private runtime projections.
- Model selection stays alias-first through `modelAlias`; harness selection is a per-agent `agentEngine` choice (`anthropic_sdk` or `deepagents`), and the resolver combines `agentEngine + modelAlias` into diagnostic `modelRoute`, read-only `executionProviderId`, and `credentialProfileRef`. Do not add public `job.harness`, job-level `agentEngine`, job-level `executionProviderId`, or raw provider model IDs at public boundaries.

Mandatory process:
1. Start by rereading the current repo truth:
   - `README.md`
   - `WORKFLOW.md`
   - `docs/FACTORY.md`
   - `docs/QUALITY.md`
   - `docs/decisions/0001-agent-runtime-platform.md`
   - `docs/architecture/codebase-refactor-principles.md`
   - `docs/architecture/capability-management.md`
   - `docs/architecture/credential-management.md`
   - `docs/architecture/current-verification-commands.md`
   - `docs/architecture/deepagents-harness-goal-prompt.md`
   - `docs/security/single-host-hardening-plan.md`
2. Browse and cite current official docs before making DeepAgents, LangChain, Anthropic SDK, Claude Agent SDK, or OpenAI behavior claims:
   - DeepAgents overview, tools, subagents, async subagents, streaming, context engineering, filesystem, backends, sandboxes, permissions, human-in-the-loop, MCP, and harness docs.
   - Claude Agent SDK TypeScript docs, secure deployment docs, sandboxing docs, sessions/resume docs, allowed-tools/MCP/permission docs, and skills docs.
   - LangChain model docs for OpenAI and Anthropic only where they affect the intended `deepagents:langchain` route.
3. Convert this goal into acceptance criteria and a capability-driven task decomposition before editing. Do not improvise the task graph inline.
4. Use parallel read-only analysis agents for at least these scopes before making broad edits:
   - runtime/session/model catalog and credential projection,
   - memory/dreaming/session continuity,
   - permissions/capabilities/MCP/skills/browser/sandbox,
   - CLI/control API/contracts/docs/tests.
5. After each agent reports, reconcile conflicts, tighten the task graph, and only then edit.
6. Keep changes clean-cut. Do not add compatibility shims, legacy fallbacks, placeholder DeepAgents code, speculative wrappers, dead files, empty directories, or broad `common`/`utils` buckets.

Bounded write scope:
- Allowed: provider-neutral harness contracts, runtime projection modules, adapter boundary code, existing Anthropic adapter updates, model catalog/provider route plumbing, memory LLM port wiring, permission bridge extraction, skill/MCP/browser projection extraction, sandbox/egress provider-neutral naming, focused docs, focused tests.
- Allowed only if required by real behavior: Postgres provider-session metadata fields or runtime event shape changes. Prefer existing neutral tables and JSON metadata where sufficient.
- Not allowed in this goal: enabling a production DeepAgents runtime lane, adding public job-level/raw harness selectors beyond per-agent `agentEngine`, adding raw DeepAgents `.mcp.json` authority, adding raw `LocalShellBackend` or raw `execute` authority, adding DeepAgents skill names as durable skill identity, or moving Claude OAuth/subscription onto DeepAgents without official support.

Acceptance criteria:
1. Execution adapter boundary:
   - `AgentExecutionAdapter` remains the only path from Gantry runtime into a harness-specific child runner.
   - Multiple execution providers can be registered without Anthropic-specific defaults in shared runtime code.
   - Shared runtime code does not import Claude Agent SDK, Anthropic SDK, or DeepAgents SDK types.
   - Existing Anthropic adapter still implements the boundary and keeps `anthropic:claude-agent-sdk` behavior working.

2. Model catalog and credentials:
   - Public model selection remains alias-first.
   - Catalog/model routing can resolve `agentEngine + modelAlias` to `executionProviderId` through provider-neutral code.
   - OpenAI API-key routing can be represented as an executable model route for a future `deepagents:langchain` adapter without accepting raw provider model IDs at public boundaries.
   - Claude OAuth/subscription models remain on `anthropic:claude-agent-sdk`.
   - Model credential env stays inside model-runtime projection only; approved tool subprocesses receive only provider-neutral `toolNetworkEnv`.
   - Raw provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and Claude OAuth tokens are never accepted from Gantry `.env` or process env as runtime authority.

3. Sessions and resume:
   - `AgentSession` remains canonical Gantry continuity state.
   - `ProviderSession` remains adapter metadata with `provider`, `externalSessionId`, `providerRef`, and metadata.
   - Shared runtime consumes a neutral provider-session output/event contract, not Claude SDK `session_id` message shapes.
   - Missing/expired provider-session handling is adapter-neutral and preserves the existing retry-without-resume behavior for the Anthropic SDK lane.
   - Provider transcript/archive and redaction logic stays provider-neutral or explicitly adapter-local.

4. Memory and dreaming:
   - Memory extraction, dreaming, consolidation, and continuity hydration depend on `MemoryLlmClient` or another provider-neutral port, not direct Claude SDK calls.
   - Anthropic memory LLM code becomes an adapter implementation, not the default shared memory runtime.
   - Memory model slots remain settings/catalog-backed and can target a future DeepAgents/OpenAI route.
   - Provider-specific names such as `llm-haiku` are renamed or contained so user-facing memory status is provider-neutral.
   - Dreaming automatic promotion/update behavior and memory review tools do not change meaning.

5. Permissions and capabilities:
   - `ToolExecutionPolicyService` or an equivalent provider-neutral service remains the only authority for risky tool decisions.
   - Claude `CanUseTool` becomes one adapter bridge over a neutral permission decision contract.
   - A future DeepAgents tool/HITL/permission bridge can map shell, file, MCP, browser, and custom tool attempts into the same neutral `ToolExecutionRequest` shape.
   - `SandboxNetworkAccess` remains Anthropic SDK-internal transient defense-in-depth, never durable authority.
   - Durable access accepts only reviewed semantic capabilities, canonical `Browser`, exact Gantry facade/admin tools, and scoped `RunCommand(...)` rules. Bare `Bash`, broad `RunCommand(*)`, provider-native tool names, and leading wildcard MCP/tool rules are rejected.

6. Skills:
   - Durable skill ids, sources, reviewed artifacts, and selected capabilities stay Gantry-owned.
   - Skill source inventory is provider-neutral.
   - Claude skill materialization becomes an Anthropic adapter renderer over the shared skill inventory.
   - A future DeepAgents skill renderer can use the same reviewed skill inventory without treating DeepAgents skill names as durable Gantry authority.
   - Runtime skill directories remain scratch projections and are not durable source of truth.

7. MCP and browser:
   - Gantry MCP tools remain the product contract.
   - Third-party MCP definitions, versions, bindings, credentials, and audit events remain Gantry/Postgres authority.
   - Claude `mcpServers` and any future DeepAgents MCP config are per-run adapter projections only.
   - Browser durable authority remains canonical `Browser`, projected into Gantry-owned browser tools; per-action backend tool names are not persisted or exposed as durable authority.

8. Sandbox and egress:
   - Runner sandbox selection remains provider-neutral.
   - Claude-specific temp/config allowances are either adapter-provided or clearly contained so DeepAgents can supply its own runtime paths.
   - Approved outbound tool traffic continues through Gantry `toolNetworkEnv` and egress gateway; model provider calls continue through the Gantry model gateway.
   - Future DeepAgents `execute` is not enabled as raw authority. It must either be disabled, mapped to Gantry policy, or wrapped by an enforcing Gantry sandbox/egress boundary before exposure.
   - Do not double-jail with conflicting DeepAgents and Gantry sandbox layers; document the selected owner for each mode.

9. CLI, control API, SDK/contracts, and docs:
   - CLI and control API expose provider-neutral model readiness and route diagnostics through existing model vocabulary.
   - No public `job.harness`, job-level `executionProviderId`, provider-native tool names, DeepAgents backend ids, or Claude settings paths are added to public contracts.
   - Docs state what is durable authority, what is runtime projection, and what is adapter-private.
   - Any changed API/contract schemas include tests and docs.

10. Tests and no-legacy cleanup:
   - Add or update focused tests for every changed boundary.
   - Existing Anthropic SDK lane regression tests continue to pass.
   - Provider-boundary checks fail if new Anthropic/Claude SDK tokens leak outside approved adapter paths.
   - Cleanup searches prove no raw DeepAgents authority, public provider-native tool names, stale Anthropic defaults, or compatibility shims were introduced.

Capability-driven task decomposition:
1. Harness contract extraction:
   - Identify the smallest shared contract for prepared runner input, runner output, provider session events, usage/context events, permission attempts, and runtime projection metadata.
   - Move only reusable contract code out of `apps/core/src/adapters/llm/anthropic-claude-agent/**`.
   - Keep Anthropic SDK imports inside the Anthropic adapter.

2. Shared capability/tool projection:
   - Extract Gantry-owned allowed tool, MCP, browser, and semantic capability projection into a provider-neutral module.
   - Keep provider renderers responsible for translating the neutral projection into Claude SDK or future DeepAgents shapes.
   - Preserve current Gantry MCP defaults and browser gating.

3. Permission bridge extraction:
   - Introduce a neutral permission bridge API consumed by adapter-specific hooks.
   - Reimplement Claude `CanUseTool` as a renderer/adapter of that neutral bridge.
   - Preserve live approval, timed approval, durable approval, scheduler denial, protected capability guard, YOLO denylist, and audit behavior.

4. Skill projection extraction:
   - Split provider-neutral skill source inventory from Claude-specific skill directory materialization.
   - Keep Claude native reserved-name handling adapter-local.
   - Preserve reviewed artifact and runtime Browser skill behavior.

5. Session/resume normalization:
   - Replace any shared runtime dependence on Claude SDK message fields with neutral provider-session output handling.
   - Preserve live provider-session persistence as soon as the runner streams or reports it.
   - Preserve retry-without-resume for missing/expired provider sessions.

6. Memory/dreaming neutralization:
   - Replace direct shared default memory dependence on Claude SDK query with a provider-neutral memory LLM client registry or route-aware implementation.
   - Keep Anthropic query code adapter-local.
   - Preserve memory model slots, dreaming decisions, review tools, and embedding behavior.

7. Model route preparation:
   - Prepare catalog/provider definitions so a future `deepagents:langchain` adapter can own OpenAI API-key and Anthropic API-key model routes.
   - Keep Claude OAuth/subscription on `anthropic:claude-agent-sdk`.
   - Do not make DeepAgents default until the adapter exists and tests prove it.

8. Sandbox/egress cleanup:
   - Move Claude-specific temp/config allowances behind adapter-provided runtime materialization where practical.
   - Keep sandbox provider and egress gateway provider-neutral.
   - Add explicit tests or cleanup evidence for raw `execute`, `.mcp.json`, and provider token leakage.

9. CLI/control/docs/contracts:
   - Update only surfaces affected by the decoupling.
   - Keep model/harness diagnostics alias-resolved and provider-neutral.
   - Document current state and future DeepAgents handoff without promising behavior not implemented in this goal.

Surface Impact Matrix requirement:
- Runtime behavior: classify as Changed and list exact affected runner/session/projection paths.
- `settings.yaml`: classify based on actual changes; if unchanged, explain that model defaults remain alias-owned.
- Postgres/runtime projection: classify based on actual changes; if unchanged, explain that existing `provider_sessions` metadata is sufficient.
- Control API: classify based on actual schema or diagnostic changes.
- SDK/contracts: classify based on exact package schema changes.
- CLI: classify based on exact command output/setup/doctor changes.
- Gantry MCP tools/admin skill: classify based on tool list or projection changes.
- Channel/provider adapters: usually Unchanged by design; explain that channels see canonical runtime messages only.
- Docs/prompts: Changed; name each doc updated.
- Audit/events: classify based on event shape or payload changes.
- Tests/verification: Changed; name tests added/updated and commands run.

Required cleanup searches before final handoff:
- Anthropic/Claude leakage outside adapter paths:
  - `rg -n "@anthropic-ai/claude-agent-sdk|@anthropic-ai/sdk|CLAUDE_CONFIG_DIR|CanUseTool|SandboxNetworkAccess|ANTHROPIC_|anthropic:claude-agent-sdk|Claude|claude" apps/core/src packages/contracts/src docs/architecture docs/security --glob '!apps/core/src/adapters/llm/anthropic-claude-agent/**'`
- Raw DeepAgents authority leakage:
  - `rg -n "deepagents|DeepAgents|LocalShellBackend|BackendProtocol|execute\\b|\\.mcp\\.json|filesystem permissions|interrupt_on" apps/core/src packages/contracts/src docs --glob '!docs/architecture/deepagents-*'`
- Public harness selector leakage:
  - `rg -n "job\\.harness|harness\\s*:|executionProviderId.*job|job.*executionProviderId" apps/core/src packages/contracts/src docs`
- Raw provider-native tool public contracts:
  - `rg -n "mcpServers|allowedTools|disallowedTools|permissionMode|CanUseTool|Bash\\(|RunCommand\\(\\*\\)|SandboxNetworkAccess" apps/core/src packages/contracts/src docs --glob '!apps/core/src/adapters/llm/anthropic-claude-agent/**'`
- Compatibility/dead-path cleanup:
  - `rg -n "legacy|compat|shim|TODO: remove|remove after refactor|old path|fallback branch|temporary bridge" apps/core/src apps/core/test docs -S`

Required focused verification:
- Run the smallest relevant checks after each slice.
- For provider-session and redaction changes:
  - `npm run test:unit -- apps/core/test/unit/session/provider-transcript-archive.test.ts apps/core/test/unit/adapters/postgres-provider-artifact-store.test.ts apps/core/test/unit/application/sessions/session-interaction-module.test.ts apps/core/test/unit/runner/claude-logging.test.ts`
- For tool/capability/permission/MCP/runtime projection changes:
  - `npm run test:unit -- apps/core/test/unit/shared/tool-execution-policy-service.test.ts apps/core/test/unit/bootstrap/channel-wiring.test.ts apps/core/test/unit/runner/protected-capability-hook.test.ts apps/core/test/unit/runner/protected-capability-guard.test.ts apps/core/test/unit/runner/mcp/scheduler-tools.test.ts apps/core/test/unit/runner/agent-capabilities.test.ts apps/core/test/unit/runner/agent-runner-ipc.test.ts apps/core/test/unit/runtime/agent-spawn.test.ts`
  - `npm run test:integration -- apps/core/test/integration/claude-agent-sdk-boundary.integration.test.ts apps/core/test/integration/permission-approval-ipc.integration.test.ts`
- For memory/dreaming changes:
  - run the focused memory/dreaming unit tests discovered with `rg -n "memory.*dream|dreaming|MemoryLlmClient|memory-llm" apps/core/test`
- Always run:
  - `python3 .codex/scripts/check_architecture.py`
  - `python3 .codex/scripts/check_task_completion.py`
- End-of-goal gates unless explicitly blocked and documented:
  - `npm run build`
  - `npm test`
  - `python3 .codex/scripts/verify.py --print-only`

Final handoff must include:
- Architecture decision actually implemented.
- Files changed grouped by surface.
- Acceptance criteria status, including any intentionally deferred criteria.
- Surface Impact Matrix.
- Cleanup search results and interpretation.
- Verification commands run, results, and any commands not run with reason.
- Remaining work required before adding the actual DeepAgents adapter.

Definition of done:
- The Anthropic SDK lane still works and remains adapter-local.
- Shared runtime/application/domain/contracts do not know Claude SDK callback shapes or DeepAgents backend details.
- Gantry-owned permissions, skills, MCP, browser, memory, sandbox, sessions, jobs, settings, and audit remain the only durable authority.
- A future `deepagents:langchain` adapter can be implemented by adding an adapter/runner and catalog routes, not by rewriting shared runtime contracts again.
```
