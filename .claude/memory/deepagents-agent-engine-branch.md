---
name: deepagents-agent-engine-branch
description: feature/deepagents-agent-engine shipped packets A-G + review round; key seams and v1 scope boundaries
metadata: 
  node_type: memory
  type: project
  originSessionId: f4873c6c-d8af-4bc7-8fde-2298d6c64d2d
---

Branch `feature/deepagents-agent-engine` (2026-06-12) implemented the full ENG-124 plan (docs/architecture/deepagents-agent-engine-handoff-plan.md): per-agent `agent_engine` (anthropic_sdk|deepagents), `modelAlias + agentEngine -> executionRoute` resolution, `deepagents:langchain` adapter + runner under apps/core/src/adapters/llm/deepagents-langchain/, authority bridge (Gantry MCP tools via @langchain/mcp-adapters, raw DeepAgents authority denied), route-aware MemoryLlmClient, jobs/live parity + AGENT_ENGINE_CHANGED audit. Commits 5a28cae2..b7c10f9e.

**Why:** future work on engines/models must respect the locked decisions in docs/decisions/2026-06-12-agent-engine-selection.md.

**How to apply:** key v1 boundaries — OpenRouter has no deepagents lane; DeepAgents shell/FS authority guarded fail-closed with locked copy; ChatAnthropic needs explicit `anthropicApiUrl` (ignores ANTHROPIC_BASE_URL env); deepagents-lane model limits come from LangChain `model.profile` at runtime, never hardcoded in the catalog (user directive). The literal `anthropic_sdk` is a provider-boundary sentinel token — always import from shared/agent-engine.ts. Update 2026-06-13 (`71f23b6f`): user directive "every LLM surface chooses harness + model" — `memory.engine` added (engine×family matrix; deepagents+anthropic = direct gateway /v1/messages client in adapters/llm/anthropic-memory-direct/); gpt entries now declare memory_* workloads (chat-only boundary lifted); zero-Anthropic deployments fully supported. Related: [[preexisting-test-failures-credential-branch]].
