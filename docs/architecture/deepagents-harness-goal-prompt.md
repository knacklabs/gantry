# DeepAgents Harness Goal Prompt

Use this prompt to create a citation-backed, decision-complete implementation
plan before changing Gantry's agent execution architecture.

```text
/goal Create a citation-backed, decision-complete implementation plan for evolving Gantry’s agent execution architecture so DeepAgents/LangChain can become the default API-key agent harness while retaining the existing Anthropic Claude Agent SDK lane for Claude OAuth/subscription-style auth.

Do not implement code in this goal. Produce a detailed sequential plan only.

Context:
- Gantry currently uses `anthropic:claude-agent-sdk` underneath, but exposes Gantry-owned public concepts such as tools, skills, MCP servers, permissions, sandbox, browser, jobs, sessions, and audit.
- The target architecture is not “replace Anthropic SDK everywhere.”
- The desired architecture is:
  1. Keep `anthropic:claude-agent-sdk` as the native Claude OAuth/subscription lane.
  2. Add `deepagents:langchain` as the default API-key harness lane for OpenAI API key, Anthropic API key, and future LangChain-compatible providers.
  3. Keep Gantry as the authority for tools, permissions, capabilities, MCP bindings, skills, sandbox, browser, sessions, jobs, settings, and audit.
  4. Treat DeepAgents and Anthropic SDK tool names as adapter-private runtime projections.

Required research and citations:
- Use current local repo files and official online docs.
- Every claim about current Gantry behavior must cite exact local file paths with line numbers.
- Every claim about DeepAgents, LangChain, OpenAI, or Anthropic SDK behavior must cite official docs URLs.
- Do not rely on prior conversation or memory as evidence.
- Browse current docs before making external claims.

Must inspect local Gantry sources:
- `README.md`, `WORKFLOW.md`, `docs/FACTORY.md`, `docs/QUALITY.md`
- `docs/decisions/0001-agent-runtime-platform.md`
- `docs/architecture/codebase-refactor-principles.md`
- `docs/architecture/capability-management.md`
- `docs/architecture/credential-management.md`
- `docs/architecture/current-verification-commands.md`
- `apps/core/src/application/agent-execution/agent-execution-adapter.ts`
- `apps/core/src/application/agent-execution/agent-execution-adapter-registry.ts`
- `apps/core/src/runtime/agent-spawn.ts`
- `apps/core/src/shared/model-provider-registry.ts`
- `apps/core/src/shared/model-catalog.ts`
- `apps/core/src/shared/gantry-tool-facades.ts`
- `apps/core/src/shared/agent-tool-references.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/**`
- `apps/core/src/application/mcp/**`
- `apps/core/src/application/permissions/**`
- `apps/core/src/runner/gantry-mcp-tool-surface.ts`
- `apps/core/src/shared/admin-mcp-tools.ts`

Must inspect official docs:
- DeepAgents overview, models, tools, subagents, async subagents, event streaming, context engineering, skills, backends, sandboxes, permissions, human-in-the-loop, and MCP docs.
- LangChain JS OpenAI and Anthropic chat model docs.
- Anthropic Agent SDK TypeScript docs, especially query options, tools, allowed tools, MCP servers, permissions, sandbox, skills, and session/resume behavior.
- OpenAI function/tool calling docs only if relevant to the DeepAgents/OpenAI API-key lane.

Output requirements:
1. Start with a concise architecture decision:
   - whether `deepagents:langchain` should be the default API-key harness,
   - whether `anthropic:claude-agent-sdk` remains as the Claude OAuth/subscription native lane,
   - what Gantry remains authoritative for.

2. Include a current-state map with citations:
   - current execution adapter seam,
   - current Anthropic SDK runner behavior,
   - current Gantry facade-to-provider-native tool projection,
   - current permission gate,
   - current sandbox projection,
   - current MCP materialization/proxy,
   - current skill materialization,
   - current model provider/catalog state,
   - current OpenAI provider gap.

3. Include the proposed target architecture:
   - execution provider IDs,
   - model catalog/provider changes,
   - shared Gantry harness projection layer,
   - DeepAgents adapter boundary,
   - retained Anthropic SDK boundary,
   - credential lanes for OpenAI API key, Anthropic API key, and Claude OAuth/subscription.

4. Include a multi-file sequential implementation plan:
   - Phase 1: decouple/reuse existing Anthropic-specific projection logic into provider-neutral Gantry harness contracts.
   - Phase 2: add shared tool/capability projection for both Anthropic SDK and DeepAgents.
   - Phase 3: add DeepAgents/LangChain execution adapter and runner.
   - Phase 4: wire OpenAI and Anthropic API-key model catalog entries to `deepagents:langchain`.
   - Phase 5: preserve Claude OAuth/subscription models on `anthropic:claude-agent-sdk`.
   - Phase 6: add DeepAgents-backed MCP, skill, browser, sandbox, permission, audit, and session behavior through Gantry-owned wrappers only.
   - Phase 7: backport useful DeepAgents-inspired shared features to Anthropic SDK lane where practical, such as provider-neutral todo/planning, context offloading, nested event streaming, and async subagent lifecycle via Gantry jobs.
   - Phase 8: tests, docs, cleanup searches, and verification.

5. Include exact public API/interface/type changes:
   - new or changed execution provider IDs,
   - model catalog/provider definitions,
   - adapter interfaces,
   - runner input/output contracts,
   - session persistence semantics,
   - runtime event shape changes if any,
   - settings/control API/CLI/MCP admin surface impacts.

6. Include strict non-goals:
   - no DeepAgents `.mcp.json` as durable authority,
   - no raw DeepAgents `LocalShellBackend` as production authority,
   - no raw DeepAgents filesystem permissions as Gantry permission authority,
   - no DeepAgents skill names as durable Gantry authority,
   - no Claude OAuth/subscription through DeepAgents unless official support is verified,
   - no provider-native tool names at public Gantry boundaries.

7. Include a Surface Impact Matrix covering:
   - runtime behavior,
   - `settings.yaml`,
   - Postgres/runtime projection,
   - control API,
   - SDK/contracts,
   - CLI,
   - Gantry MCP tools/admin skill,
   - channel/provider adapters,
   - docs/prompts,
   - audit/events,
   - tests/verification.
   Mark each as Changed, Read-only/observable, Unchanged by design, Deferred, or Not applicable, and give a reason for every Deferred or Unchanged entry.

8. Include test plan:
   - unit tests for provider-neutral tool projection,
   - permission allow/deny/malformed/timeout behavior,
   - sandbox protected path behavior,
   - MCP selected-server projection only,
   - browser canonical `Browser` projection,
   - skill selection/projection,
   - OpenAI API-key DeepAgents model run,
   - Anthropic API-key DeepAgents model run if supported by docs,
   - Claude OAuth Anthropic SDK lane regression,
   - session/resume or transcript continuity,
   - job execution and audit event coverage.

9. Include cleanup/no-legacy verification:
   - exact search terms for stale Anthropic-only coupling,
   - exact search terms for raw DeepAgents authority leakage,
   - exact search terms for raw provider-native public tool names,
   - exact search terms for unsafe `.mcp.json`, `LocalShellBackend`, raw `execute`, raw filesystem backend usage.

10. Include final verification commands:
   - choose the smallest relevant commands from `docs/architecture/current-verification-commands.md`,
   - include architecture checks,
   - include targeted tests,
   - include final build/test gates,
   - explain any commands intentionally deferred.

Final output should be a detailed but readable engineering plan, not code. It must be precise enough that another engineer or agent can implement the sequence without making architecture decisions.
```
