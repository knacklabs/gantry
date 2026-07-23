---
name: fixed-image-worker-mode
description: "Fixed-image worker product mode — no-permission tool projection + image-inventory preflight, gated by runtime.worker.fixed_image_mode"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1751a743-61c8-4e96-8cda-69a76f28a1b5
---

Shipped on branch `feature/mworker-01-safe-multi-worker-execution` (2026-06-11): fixed-image worker mode = no authority tools for user-facing agents/jobs + selected-capability preflight against the worker image inventory.

Single gate: `runtime.worker.fixed_image_mode` setting (default **true**) in runtime-settings-{types,defaults,parser,renderer}.ts. It controls BOTH behaviors below.

**No-permission tool projection.** `agent-spawn.ts` resolves `noPermissionTools = runtime.worker.fixedImageMode` and spreads it into `runnerInput` (RunnerAgentInput, added in agent-spawn-helpers.ts) → runner reads it from stdin JSON → query-loop passes `noPermissionTools` into `composeAgentCapabilities` → agent-capabilities sets `GANTRY_NO_PERMISSION_TOOLS` env + empties `GANTRY_ADMIN_MCP_TOOLS_JSON` + excludes authority tools from allowed lists → `runner/mcp/server.ts` `effectiveEnabledMcpToolNames(...)` strips `AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES` (request_* + request_agent_profile_update) and all admin tools when the flag is set. Authority set defined in `gantry-mcp-tool-surface.ts`. **Legacy preserved when flag off**: admin tools stay registered and gated at call time (the ipc-mcp-stdio tests assert this, so the server must keep force-adding admin tools when noPermission is false).

**Image-inventory preflight (fail closed).** Worker reads `GANTRY_IMAGE_CAPABILITIES_JSON` at registration (`jobs/worker-identity.ts` → `shared/worker-image-inventory.ts`) and persists it as worker capabilities. Jobs: `job-readiness-service.ts` takes `workerImageInventory` (passed by `execution-readiness.ts`) and adds a `missing_capability`/`semantic_capability` blocker when a selected capability is absent. Live + backstop: `agent-spawn.ts` `fixedImageCapabilityPreflightError` returns an error AgentOutput before the runner process starts. **Enforcement rule: only when inventory is non-empty** (empty = undeclared = dev, not enforced) — this keeps dev/tests working without the env set.

Not done (follow-ups): docs/CLAUDE.md still list request_*/admin tools as agent-facing; richer live-turn `setup_required` state UX (currently fail-closed via error output). See [[agent-access-simplification]].
