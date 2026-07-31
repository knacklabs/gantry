# Scheduled reviewed MCP execution defect

Status: scheduled-context fix implemented on 2026-07-31; end-to-end
acceptance is blocked by the separate stdio proxy execution defect documented
in `scheduled-stdio-mcp-proxy-execution-defect.md`.

## Problem

A scheduled non-interactive job can pass readiness with an app-scoped reviewed
MCP capability and receive the expected runtime projection, but still finish
without invoking the reviewed MCP tools. The run reports that `mcp_call_tool`
and `async_mcp_call` require an originating chat reference.

Scheduled jobs already carry canonical application execution context. They
must not require a fabricated interactive chat or thread to execute an MCP
action authorized by their reviewed current-run capability.

## Reproduction evidence

- Application: `manipal-tender-copilot`
- Job: `388900b6-a43a-490b-b600-cb1edc6acf84`
- Run: `2db7eff3-7204-4e53-8e18-56b4f061151c`
- Capability: `source_discovery.firecrawl@1.0.0`
- Capability registration audit receipt:
  `mcp-audit:6abde597-c186-410a-bdbf-880906b7f4fb`
- Preflight: passed with no missing access requirements.
- Host projection: one attached/projected/materialized MCP source, four
  reviewed MCP tools, and one semantic capability.
- MCP tool activity audit receipts: none.
- Terminal result: scheduled context did not provide the originating chat
  reference required by `mcp_call_tool` and `async_mcp_call`.
- Safety outcome: the caller rejected fabricated receipt `fc_search_001`; zero
  candidates were accepted.

## Required fix

Trace scheduled and delegated MCP invocation from the projected semantic
capability through the Gantry MCP facade/IPC handler. Authorize from the
host-created run policy and canonical job execution context. Do not synthesize
a chat or relax reviewed capability checks.

Add an integration test that starts a scheduled non-interactive run with one
reviewed `mcp_tool` binding, executes the bound tool, persists a real
`mcp.tool_activity` receipt, and succeeds without `conversationJid` or
`threadId` being treated as an interactive-chat prerequisite. Cover delegated
execution as well because the canary delegated its bounded Firecrawl work.

## Surface Impact Matrix

| Surface                      | Impact                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed: scheduled and delegated reviewed MCP calls execute from canonical run authority.                                         |
| `settings.yaml`              | Unchanged by design: the capability and source are already projected correctly.                                                   |
| Postgres/runtime projection  | Read-only/observable: existing job, capability, MCP source, run, and audit records provide authority and receipts.                |
| Control API                  | Unchanged by design: registration, readiness, run, and event APIs already expose the required state.                              |
| SDK/contracts                | Unchanged by design: no new public registration or execution contract is required.                                                |
| CLI                          | Unchanged by design: this is a runner execution path defect.                                                                      |
| Gantry MCP tools/admin skill | Changed: scheduled `mcp_call_tool`/`async_mcp_call` handling must accept canonical run context without interactive-chat coupling. |
| Channel/provider adapters    | Unchanged by design: scheduled execution is channel-neutral.                                                                      |
| Docs/prompts                 | Changed only if current MCP guidance incorrectly implies an interactive-chat prerequisite.                                        |
| Audit/events                 | Changed: successful scheduled calls must emit real `mcp.tool_activity` receipt IDs.                                               |
| Tests/verification           | Changed: add scheduled and delegated non-interactive reviewed-MCP integration coverage.                                           |

## Acceptance

1. The same Manipal canary produces at least one real Firecrawl
   `mcp.tool_activity` receipt.
2. The receipt is visible to the caller's existing per-seed evidence validator.
3. No originating-chat error is emitted.
4. No fabricated context, wildcard, direct database write, or exact-tool
   workaround is introduced.

## Fix verification

Gantry now sends the trusted job ID, run ID, run handle, and run lease fence
through all four MCP facade IPC requests. The host accepts a scheduled target
only when those values match the host-created sandbox policy and active run
lease. Interactive calls retain the existing originating-channel check.

Canary trigger `a88a4d47-4a15-49f2-a5f4-6f9baa39aaff` produced run
`c479cc38-3c66-480e-a7fe-31bdd3ef5dbf`. It did not emit the prior originating
chat error. It reached the MCP proxy and exposed the next fail-closed boundary:
the configured Firecrawl `stdio_template` transport cannot yet execute through
the current-session proxy. No real MCP receipt was emitted, and the caller
correctly rejected the model-provided IDs.
