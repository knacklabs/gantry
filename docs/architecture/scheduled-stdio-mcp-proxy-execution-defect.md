# Scheduled stdio MCP routing defect

Status: fixes implemented and direct Firecrawl execution verified locally on
2026-07-31. The final durable-receipt canary is blocked before tool execution
by exhausted model credit.

## Problem

Gantry already has a reviewed native Claude SDK stdio path. It materializes the
approved source, intersects the source binding with exact selected semantic
capability bindings, exposes only that intersection, and wraps the stdio
process with the existing audit proxy.

Three defects prevented that existing path from being used:

1. Generated runtime guidance told the model to avoid direct third-party MCP
   tools and route every call through `mcp_call_tool`. That generic proxy
   supports HTTP and SSE but deliberately rejects `stdio_template`.
2. After direct routing was enforced, the runner sandbox's controlled `PATH`
   omitted the image-local npm bin directory. The wrapper's second-stage
   `spawn("firecrawl-mcp")` therefore failed with `ENOENT` before JSON-RPC
   initialization, even though the reviewed bundled binary was healthy.
3. Successful native calls were written to the runner audit file, but the
   scheduled-job event forwarding allowlist omitted `mcp.tool_activity`, so
   durable caller receipt validation could not observe them.

The second defect is generic to reviewed bare installed-package commands; it is
not Firecrawl-specific.

## Reproduction evidence

- Application: `manipal-tender-copilot`
- Job: `8e9218b4-754b-4000-a2ae-7ec3e1337436`
- Proxy-routing run: `bf22c106-e3ff-4561-bceb-4ac65c4cde1b`
- Scrubbed-`PATH` run: `ba674566-811a-40e5-bf73-5a273b046613`
- Scheduled synthetic conversation:
  `app:manipal-tender-copilot:source-discovery-schedule-35`
- The prior originating-chat rejection was absent.
- The proxy-routing run selected `mcp_call_tool` and received the deliberate
  stdio proxy rejection.
- The direct-routing run exposed the reviewed direct actions, but its delegated
  worker reported the Firecrawl server still connecting and produced no
  `tools/call` frame.
- An exact container probe reproduced the startup failure with
  `spawn firecrawl-mcp ENOENT` when the wrapper received the scrubbed
  environment. The same bundled binary and wrapper completed JSON-RPC
  initialization when the controlled runtime `PATH` was supplied.
- `gantry.mcp_server_audit_events` contained no `tool_activity` receipt for the
  run.
- The Source Discovery completion gate accepted no candidates.

## Verification evidence

- Run `41971d29-0e3b-469e-b3de-ec11ad0b387c` projected
  `/app/node_modules/.bin/firecrawl-mcp` through the audit wrapper and reached
  `api.firecrawl.dev` under `source_discovery.firecrawl`.
- Before the runtime was recreated with the final forwarding patch, that run
  recorded 37 successful native Firecrawl operations across search, scrape,
  and map, with no proxy-routing or `ENOENT` recurrence.
- Focused unit coverage proves scheduled jobs forward the existing
  `mcp.tool_activity` payload unchanged.
- Final image `sha256:6cc4b13f976ea70c555071a922eac3d31fbc51edeb64e45f82fd000feb1d8cab`
  is healthy locally. Its canary run
  `1745fd0c-28f4-466a-b108-7ccfa4534bda` dead-lettered before any tool call
  because the provider returned `Credit balance is too low`.

## Fix

Keep local `stdio_template` execution on Gantry's existing native SDK path:

- call directly mounted reviewed `mcp__server__tool` actions directly;
- use `mcp_call_tool` only for proxy-capable sources without a directly mounted
  action;
- when all selected external actions are directly mounted, remove the proxy
  execution tools from the Gantry MCP registration and allowed set, and add
  them to the SDK disallowed set;
- resolve reviewed bare stdio commands against the runtime-local npm bin
  directory (then the host `PATH`) while writing the runner MCP config, before
  sandbox projection removes that image-local directory;
- retain the existing source/capability intersection, credential projection,
  egress policy, stdio audit wrapper, cancellation, and cleanup;
- forward the existing `mcp.tool_activity` runtime event from scheduled
  runners so its real tool-call IDs reach the durable event stream;
- do not add another stdio process runner or a Firecrawl-specific Gantry path.

The Source Discovery receipt validator and completion gate remain unchanged.

## Surface Impact Matrix

| Surface                      | Impact                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed: direct-only runs suppress proxy execution; reviewed bare commands are projected as absolute paths. |
| `settings.yaml`              | Unchanged by design: Firecrawl is already an approved installed-package template.                        |
| Postgres/runtime projection  | Read-only/observable: existing source, binding, capability, run, and audit records remain authority.     |
| Control API / SDK / CLI      | Unchanged by design: no public contract is needed.                                                       |
| Gantry MCP tools/admin skill | Changed: MCP help and inventory distinguish direct mounted actions from proxy-capable sources.           |
| Channel/provider adapters    | Unchanged by design: the native Claude SDK stdio adapter already owns execution and audit.               |
| Docs/prompts                 | Changed: remove the contradictory proxy-only instruction.                                                |
| Audit/events                 | Changed: scheduled jobs now forward the existing stdio audit wrapper's `mcp.tool_activity`.              |
| Tests/verification           | Changed: exact projection, routing suppression, scrubbed-environment startup, and stdio audit behavior.  |

## Acceptance

1. The same scheduled Source Discovery job invokes at least one directly
   mounted reviewed Firecrawl tool.
2. A real `mcp.tool_activity` receipt is persisted and visible to the existing
   per-seed evidence validator.
3. Only the four exact selected Firecrawl bindings are exposed; an unselected
   or wildcard-only capability exposes none.
4. The existing native stdio audit, credential, egress, cancellation, and
   cleanup controls remain in force.
5. No second stdio runner, fabricated chat, wildcard grant, hosted MCP
   dependency, or Firecrawl-specific Gantry branch is introduced.
