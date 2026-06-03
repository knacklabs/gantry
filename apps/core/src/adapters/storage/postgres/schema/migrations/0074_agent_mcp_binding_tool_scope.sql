ALTER TABLE agent_mcp_server_bindings ADD COLUMN IF NOT EXISTS allowed_tool_patterns_json text NOT NULL DEFAULT '[]';
