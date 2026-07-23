---
name: agent-access-simplification
description: "Agent Access Simplification cut — COMPLETE (single \"Agent Access\" model replaced capability/source/permission surface; verify.py passed)"
metadata:
  node_type: memory
  type: project
  originSessionId: d89eac0f-3bcf-4bc9-9cb3-4dbb2b4d55f6
---

COMPLETE single-cut refactor replacing the split capability/source/permission product surface with one "Agent Access" model. No backward-compat (see [[feedback_no_backward_compat]]). Principle applied throughout: **public surfaces say "access"; internal security primitives keep their names** (binding tables, `request_permission` IPC type + review pipeline, `capabilityRequestSource:'propose_capability'` marker, audit/event taxonomy, internal `RuntimeConfiguredAgent.sources/.capabilities` fields, `AgentCapabilityAdministrationService`).

All shipped + green: `python3 .codex/scripts/verify.py` PASSED (format, architecture, runtime-truth, factory python tests, `npm run build`, full `npm test`). Full unit suite 2842 passed; integration green (postgres/e2e baselines skipped without env, per [[preexisting-test-failures-credential-branch]]).

- **Settings**: `settings.yaml` agents use `access.sources` + `access.selections` (parser/renderer/compact). Internal field names kept.
- **Migration**: none — settings.yaml is the user-intent source projecting into existing binding tables; no new tables.
- **Control API**: single `GET/PUT /v1/agents/:id/access` (replaced split `/sources`+`/capabilities`); `AgentAccessRequest/Response` contracts + OpenAPI + CLI skill caller.
- **MCP**: `request_access` (5 target kinds: capability/run_command/tool/provider_capability/propose) replaced capability_search, propose_capability, manage_capability, capability_status, and the agent-facing request_permission tool. All guidance/recovery strings, `BASELINE_GANTRY_MCP_TOOL_NAMES`, `CLAUDE.md`, gantry-admin skill, docs updated.
- **Jobs (full internal merge)**: `Job.access_requirements: JobAccessRequirement[]` (target = tool_rule|capability|mcp_server) replaced the three lists end-to-end (domain, create/update, Postgres `canonical-job-ops-service`, ipc-scheduler handlers + parsing, `scheduler_*` MCP tool `access_requirements` schema, CLI, control routes, contracts, SDK). New `application/jobs/job-access-requirements.ts` = `normalizeAccessRequirements` (validates, create/update) + `splitAccessRequirements` (pure structural split for preflight; does NOT re-validate — readiness tolerates incomplete reqs as blockers). Event-payload field names (`tool_access_requirements`/`missing_tool_access_requirements`) kept as event taxonomy. Job update is now **full-replace** of the access document.
- **CLI/docs**: `gantry agent access show/apply <agent> [--file <path|->]` (impl in cli/group-access.ts, kept group.ts under 820-line budget); `gantry credentials capability`→`gantry credentials access` (CLI + recovery messages; `--allow <capabilityId>` and internal secret authorization stay capability-scoped); README + architecture/SDK docs.
- **Verify scripts updated** for the rename: `.codex/scripts/check_runtime_truth.py` + `.codex/scripts/tests/test_check_runtime_truth.py` now require `request_access` (was `request_permission`).

**Deferred follow-up (not blocking):** verbose access-summary prompt injection (host-side, cross-process). Summary still surfaces via `mcp_list_tools`; `capabilityStatusText()` in runner/mcp/context.ts builds it; host data in adapters/llm/anthropic-claude-agent/agent-capabilities.ts. All changes uncommitted in the working tree.
