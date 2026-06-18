# MCP Application Notes

- Direct `mcp_call_tool` execution must not depend on a prior `mcp_describe_tool`: resolve and cache the requested tool detail before invoking the remote tool when result-schema validation needs remote metadata.
- Treat MCP tool schemas as untrusted remote metadata. Do not persist raw MCP schemas as durable authority without a reviewed capability and storage contract.
- Bound untrusted MCP tool results before full serialization; never call raw `JSON.stringify` on a remote result before applying size, depth, and item caps.
