ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS network_hosts_json text NOT NULL DEFAULT '[]';
