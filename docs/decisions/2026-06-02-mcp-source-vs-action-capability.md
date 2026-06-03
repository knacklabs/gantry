# 2026-06-02 - MCP Source Vs Action Capability

## Context

Third-party MCP servers currently have two different concepts in the codebase:

- a connected server source, stored as `mcp_servers` plus
  `agent_mcp_server_bindings`;
- reviewed agent authority, stored as selected tool/capability bindings and
  projected into runtime rules.

Installing or binding an MCP server must not imply authority to call every tool
that server exposes. MCP servers can change their tool list, tool schemas, host
behavior, or credential usage without changing the fact that the source is
connected. Treating the server binding as action authority would collapse source
inventory and grants.

## Decision

MCP server connection is source inventory only. Durable action authority is a
reviewed semantic capability whose implementation binding names one or more exact
MCP tools from that source.

The user-visible contract is:

1. `request_mcp_server` asks to connect an MCP source. Approval records the
   source, reviewed transport, sandbox profile, credential refs, and discovery
   allowlist. It does not grant tool calls.
2. `mcp_list_tools` refreshes source inventory for connected sources. Returned
   raw tool names are candidates for review, not durable capability ids.
3. `request_access target.kind=capability` asks for a reviewed semantic
   capability such as `github.issue.create`. The capability definition may
   project to exact MCP tool rules such as `mcp__github__create_issue`.
4. `mcp_call_tool` may call only a connected source and only when current-run
   runtime access covers that exact tool through a reviewed capability
   projection.

Do not add durable grants for raw third-party MCP tool names, MCP wildcards, or
server-wide MCP authority. Broad action needs must be represented as reviewed
semantic capabilities with explicit `can`/`cannot`, risk, credential refs, and
exact MCP tool bindings.

## Minimal Storage Plan

Keep `mcp_servers` and `agent_mcp_server_bindings` as source attachment and
readiness state. They continue to answer "is this source connected to this
agent?" and should not become grant tables.

Use `tool_catalog` for reviewed MCP-backed semantic capabilities. The catalog
item stores the semantic capability schema, and each implementation binding uses
`kind: "mcp_tool"` with an exact `mcp__<server>__<tool>` value. The target
agent's selected capability remains in `agent_tool_bindings` and mirrored in
`settings.yaml` as `agents.<id>.access.selections`.

Add a small inventory table only if live MCP discovery must be durable:

- `mcp_server_tool_inventory`: `app_id`, `server_id`, `tool_name`,
  `description`, `input_schema_json`, `observed_at`, `status`.

This table is read-only inventory. It must not be consulted as authority except
to help reviewers create or update semantic capability definitions.

## Implementation Plan

1. Tighten durable wording and validation.
   - Reject or reword every path that suggests durable raw third-party MCP tool
     grants or server-wide MCP grants.
   - Verify with searches for `MCP server capability`, `mcp__.*__*`, and
     `exact third-party MCP tool`.

2. Make MCP proxy authorization tool-exact.
   - Resolve the target agent's `CapabilityRuntimeAccess` and filter
     `sourceType: "mcp_server"` entries by exact `allowedTools`.
   - Require the server to also be attached through active
     `agent_mcp_server_bindings`.
   - `mcp_list_tools` lists connected source inventory but marks ungranted tools
     as not callable.

3. Add reviewed MCP action capability creation.
   - Create or extend the capability review path so an admin can promote a
     discovered MCP tool into a semantic capability definition.
   - The reviewed definition must include display name, risk, `can`, `cannot`,
     credential source, and exact `mcp_tool` implementation binding.

4. Keep settings round trip source-neutral.
   - `sources.mcp_servers` stores attached server ids.
   - `selections` stores semantic capability ids, never `mcp__server__tool`.
   - Reconciliation replaces stale Postgres projections from settings and fails
     if a selected MCP-backed capability references a missing or inactive source.

5. Audit and events.
   - Audit source connect/disconnect as MCP source events.
   - Audit capability grant/revoke as permission/capability decisions.
   - Audit each `mcp_call_tool` with server name, tool name, selected capability
     id, and redacted argument summary.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | `mcp_call_tool` must authorize exact tools from reviewed capability runtime access, while server binding remains source readiness. |
| `settings.yaml` | Changed | `sources.mcp_servers` remains source attachment; selected MCP actions are only semantic capability ids in `access.selections`. |
| Postgres/runtime projection | Changed | Existing MCP server/binding tables stay source state; reviewed action authority uses `tool_catalog` and `agent_tool_bindings`; optional discovered-tool inventory is non-authority. |
| Control API | Changed | MCP connect/list surfaces report source inventory separately from selected capabilities; capability-review endpoints must create MCP-backed semantic definitions. |
| SDK/contracts | Changed | Public contracts should expose connected MCP sources and reviewed capability selections separately; raw MCP tool ids stay implementation details. |
| CLI | Changed | MCP connect/list/show output must show "source connected" separately from "allowed capabilities". |
| Gantry MCP tools/admin skill | Changed | `request_mcp_server`, `mcp_list_tools`, `mcp_call_tool`, and `request_access` copy and handlers must preserve the source/action split. |
| Channel/provider adapters | Unchanged by design | Channel adapters render neutral approval descriptors only; they do not decide MCP authority. |
| Docs/prompts | Changed | Capability, jobs, SDK, and prompt guidance must stop describing MCP source approval as action authority. |
| Audit/events | Changed | Source events and capability grant/call events are separate audit records. |
| Tests/verification | Changed | Unit and integration tests must cover source-only install, per-tool grant, denied ungranted tool, settings round trip, and cleanup searches. |

## Acceptance Criteria

- Connecting an MCP server leaves `access.selections` unchanged.
- A connected MCP server with no selected MCP-backed semantic capability can be
  listed but cannot call tools.
- Selecting `capability:<id>` for an MCP-backed action projects only the exact
  reviewed MCP tool names for that capability.
- A raw `mcp__server__tool`, `mcp__server__*`, or server-wide MCP grant cannot
  be persisted through settings, API, CLI, MCP admin tools, or permission review.
- Job readiness can require a reviewed semantic capability and can inspect MCP
  source readiness, but jobs do not gain separate MCP authority.

## Verification

Focused checks:

```bash
npm run test:unit -- apps/core/test/unit/application/agent-capability-administration-service.test.ts apps/core/test/unit/runner/agent-capabilities.test.ts apps/core/test/unit/runner/mcp/service-tools.test.ts apps/core/test/unit/shared/semantic-capabilities.test.ts
npm run test:integration -- apps/core/test/integration/permission-approval-ipc.integration.test.ts
rg -n "MCP server capability|server-wide MCP|exact third-party MCP tool|mcp__[^_]+__\\*" docs apps/core/src apps/core/test -S
python3 .codex/scripts/check_architecture.py
```

Final phase checks:

```bash
npm run test:unit
npm run test:integration
npm run build
python3 .codex/scripts/verify.py --print-only
```
