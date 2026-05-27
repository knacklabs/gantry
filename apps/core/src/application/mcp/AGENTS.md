# MCP Application Notes

- MCP caller identity projection belongs in `mcp-caller-identity.ts`. Both
  runner startup materialization and Gantry MCP proxy calls must use this owner
  so required identity headers are signed consistently.
- Customer-facing projection failures must stay safe: do not return internal
  secret, header, configuration, or admin guidance through `mcp_list_tools` or
  `mcp_call_tool` responses.
