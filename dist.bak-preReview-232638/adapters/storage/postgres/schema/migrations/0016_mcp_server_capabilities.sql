CREATE TABLE IF NOT EXISTS mcp_servers (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  display_name text,
  description text,
  status text NOT NULL DEFAULT 'draft',
  created_source text NOT NULL DEFAULT 'admin',
  risk_class text NOT NULL DEFAULT 'medium',
  requested_by text,
  requested_reason text,
  latest_approved_version_id text,
  approved_by text,
  approved_at timestamptz,
  rejected_by text,
  rejected_at timestamptz,
  disabled_by text,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_app_name
  ON mcp_servers(app_id, name);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_app_status
  ON mcp_servers(app_id, status);

CREATE TABLE IF NOT EXISTS mcp_server_versions (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  server_id text NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  version integer NOT NULL,
  transport text NOT NULL,
  config_json text NOT NULL,
  allowed_tool_patterns_json text NOT NULL DEFAULT '[]',
  auto_approve_tool_patterns_json text NOT NULL DEFAULT '[]',
  credential_refs_json text NOT NULL DEFAULT '[]',
  sandbox_profile_id text,
  config_hash text NOT NULL,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_server_versions_server_version
  ON mcp_server_versions(server_id, version);

CREATE INDEX IF NOT EXISTS idx_mcp_server_versions_app_server
  ON mcp_server_versions(app_id, server_id);

CREATE TABLE IF NOT EXISTS agent_mcp_server_bindings (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  server_id text NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  version_id text NOT NULL REFERENCES mcp_server_versions(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active',
  required boolean NOT NULL DEFAULT false,
  permission_policy_ids_json text NOT NULL DEFAULT '[]',
  conversation_id text,
  thread_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_mcp_server_bindings_unique
  ON agent_mcp_server_bindings(app_id, agent_id, server_id);

CREATE INDEX IF NOT EXISTS idx_agent_mcp_server_bindings_agent_status
  ON agent_mcp_server_bindings(app_id, agent_id, status);

CREATE TABLE IF NOT EXISTS mcp_server_audit_events (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  server_id text REFERENCES mcp_servers(id) ON DELETE SET NULL,
  version_id text REFERENCES mcp_server_versions(id) ON DELETE SET NULL,
  binding_id text REFERENCES agent_mcp_server_bindings(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  actor_id text,
  reason text,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_server_audit_events_app_server
  ON mcp_server_audit_events(app_id, server_id);

CREATE INDEX IF NOT EXISTS idx_mcp_server_audit_events_app_created
  ON mcp_server_audit_events(app_id, created_at);
