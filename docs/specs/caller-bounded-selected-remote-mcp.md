---
slug: caller-bounded-selected-remote-mcp
title: Caller-bounded jobs with selected remote MCP calls
status: confirmed
saved: 2026-08-11T23:36:06+00:00
---

# Caller-Bounded Jobs With Selected Remote MCP Calls

## Why

An autonomous job may need exact SDK-caller tools for human interaction while
also invoking an already connected, reviewed remote MCP capability. Remote
HTTP/SSE MCP calls pass through Gantry's `mcp_call_tool`; caller-bounded jobs
currently hide that proxy together with all generic tools. This makes the two
approved mechanisms mutually exclusive.

## Behaviour

1. A job may set `callerResolvedTools.allowSelectedMcpToolCalls` to true.
2. The run exposes the declared caller tools plus only
   `mcp__gantry__mcp_call_tool` from the MCP proxy family.
3. MCP list, search, describe, Browser, native SDK, baseline, shell, file, and
   authority-changing tools stay hidden.
4. The flag grants no MCP authority. Calls still require an attached source and
   exact reviewed semantic capability through the existing authorization path.
5. Omitting the flag preserves the current exclusive caller-tool surface.
6. Prompt guidance tells the agent to call caller tools directly and use
   `mcp_call_tool` only for its selected remote MCP action.
7. Sanitized MCP activity may include only a bounded, token-shaped
   `operation` discriminator and explicitly selected evidence/checkpoint/trace
   references. Raw arguments and nested values remain excluded. Downstream
   domain adapters may use this generic metadata without adding product
   semantics to Gantry.

## Acceptance criteria

- Contract validation accepts the optional flag and rejects non-boolean values.
- Runtime tests prove the exact opted-in tool set and unchanged default set.
- Prompt tests prove direct caller tools are not routed through MCP and selected
  remote MCP actions are not treated as caller tools.
- Existing MCP source, semantic authority, credential, network, audit, locked-
  preset, deadline, and permission enforcement is unchanged.
- Audit tests prove that operation metadata and evidence references are visible
  while CAPTCHA answers and unrelated values remain absent.
