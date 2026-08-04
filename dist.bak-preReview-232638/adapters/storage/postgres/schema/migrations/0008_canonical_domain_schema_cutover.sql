-- Canonical domain schema single cut.
-- This migration intentionally removes obsolete runtime identity tables and does
-- not preserve unsupported local state.

DROP TABLE IF EXISTS webhook_deliveries CASCADE;
DROP TABLE IF EXISTS webhook_registrations CASCADE;
DROP TABLE IF EXISTS app_response_routes CASCADE;
DROP TABLE IF EXISTS control_events CASCADE;
DROP TABLE IF EXISTS job_triggers CASCADE;
DROP TABLE IF EXISTS app_sessions CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS registered_groups CASCADE;
DROP TABLE IF EXISTS job_events CASCADE;
DROP TABLE IF EXISTS job_runs CASCADE;
DROP TABLE IF EXISTS jobs CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS chats CASCADE;
DROP TABLE IF EXISTS memory_items CASCADE;
DROP TABLE IF EXISTS memory_subjects CASCADE;

CREATE TABLE IF NOT EXISTS apps (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS llm_profiles (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  model_alias text NOT NULL,
  thinking_json text NOT NULL DEFAULT '{}',
  budget_json text NOT NULL DEFAULT '{}',
  credential_profile_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  current_config_version_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_config_versions (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  prompt_profile_ref text NOT NULL,
  llm_profile_id text NOT NULL REFERENCES llm_profiles(id),
  capability_refs_json text NOT NULL DEFAULT '[]',
  source_refs_json text NOT NULL DEFAULT '[]',
  permission_policy_ids_json text NOT NULL DEFAULT '[]',
  sandbox_profile_id text,
  workspace_snapshot_id text,
  runtime_limits_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_config_versions_agent_id_version_unique UNIQUE (agent_id, version)
);

CREATE TABLE IF NOT EXISTS channel_providers (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  capability_flags_json text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_installations (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  provider_id text NOT NULL REFERENCES channel_providers(id),
  external_ref_json text,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  runtime_secret_refs_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  channel_installation_id text NOT NULL REFERENCES channel_installations(id) ON DELETE CASCADE,
  external_ref_json text,
  kind text NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_installation
  ON conversations(channel_installation_id);

CREATE TABLE IF NOT EXISTS conversation_threads (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_ref_json text,
  title text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_threads_conversation
  ON conversation_threads(conversation_id);

CREATE TABLE IF NOT EXISTS agent_channel_bindings (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel_installation_id text NOT NULL REFERENCES channel_installations(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  thread_id text REFERENCES conversation_threads(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  trigger_pattern text,
  requires_trigger boolean NOT NULL DEFAULT true,
  is_admin_binding boolean NOT NULL DEFAULT false,
  memory_subject_json text NOT NULL,
  workspace_snapshot_id text,
  permission_policy_ids_json text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_channel_bindings_conversation
  ON agent_channel_bindings(conversation_id, thread_id);

CREATE TABLE IF NOT EXISTS canonical_messages (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  thread_id text REFERENCES conversation_threads(id) ON DELETE CASCADE,
  external_ref_json text,
  direction text NOT NULL,
  sender_user_id text,
  sender_display_name text,
  trust text NOT NULL,
  created_at timestamptz NOT NULL,
  received_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_canonical_messages_conversation_cursor
  ON canonical_messages(conversation_id, thread_id, created_at, id);

CREATE TABLE IF NOT EXISTS message_parts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id text NOT NULL REFERENCES canonical_messages(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  kind text NOT NULL,
  payload_json text NOT NULL,
  CONSTRAINT message_parts_message_id_ordinal_unique UNIQUE (message_id, ordinal)
);

CREATE TABLE IF NOT EXISTS message_attachments (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES canonical_messages(id) ON DELETE CASCADE,
  kind text NOT NULL,
  content_type text,
  size_bytes integer,
  external_ref_json text,
  storage_ref text,
  trust text NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id text REFERENCES conversations(id),
  thread_id text REFERENCES conversation_threads(id),
  job_id text,
  user_id text,
  status text NOT NULL DEFAULT 'active',
  model_override text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reset_at timestamptz
);

CREATE TABLE IF NOT EXISTS provider_sessions (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  provider_ref_json text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  config_version_id text NOT NULL REFERENCES agent_config_versions(id),
  session_id text REFERENCES agent_sessions(id),
  conversation_id text REFERENCES conversations(id),
  thread_id text REFERENCES conversation_threads(id),
  message_id text REFERENCES canonical_messages(id),
  job_id text,
  llm_profile_id text NOT NULL REFERENCES llm_profiles(id),
  permission_decision_ids_json text NOT NULL DEFAULT '[]',
  sandbox_lease_id text,
  workspace_snapshot_id text,
  cause text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  result_summary text,
  error_summary text
);

CREATE TABLE IF NOT EXISTS agent_run_events (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload_json text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_cursor
  ON agent_run_events(run_id, created_at, id);

CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name text NOT NULL,
  prompt text NOT NULL,
  model_override text,
  schedule_json text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  execution_mode text NOT NULL DEFAULT 'parallel',
  target_json text NOT NULL DEFAULT '{}',
  silent boolean NOT NULL DEFAULT false,
  timeout_ms integer NOT NULL DEFAULT 300000,
  max_retries integer NOT NULL DEFAULT 3,
  retry_backoff_ms integer NOT NULL DEFAULT 5000,
  next_run_at timestamptz,
  last_run_at timestamptz,
  lease_run_id text REFERENCES agent_runs(id),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_app_status_next_run
  ON jobs(app_id, status, next_run_at);

CREATE TABLE IF NOT EXISTS job_triggers (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id text REFERENCES agent_runs(id),
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_subjects (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind text NOT NULL,
  external_ref_json text NOT NULL DEFAULT '{}',
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_items (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  subject_id text NOT NULL REFERENCES memory_subjects(id) ON DELETE CASCADE,
  kind text NOT NULL,
  key text NOT NULL,
  value_json text NOT NULL,
  confidence double precision NOT NULL DEFAULT 1,
  source_ref_json text NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  last_observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_items_active_unique
  ON memory_items(subject_id, kind, key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_memory_items_subject_updated
  ON memory_items(subject_id, status, updated_at);

CREATE TABLE IF NOT EXISTS tool_catalog_items (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  input_schema_json text NOT NULL DEFAULT '{}',
  output_schema_json text NOT NULL DEFAULT '{}',
  risk text NOT NULL,
  permission_policy_id text,
  sandbox_profile_id text,
  adapter_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_catalog_items (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  version text NOT NULL,
  prompt_refs_json text NOT NULL DEFAULT '[]',
  tool_refs_json text NOT NULL DEFAULT '[]',
  workflow_refs_json text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permission_policies (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permission_rules (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  policy_id text NOT NULL REFERENCES permission_policies(id) ON DELETE CASCADE,
  priority integer NOT NULL,
  effect text NOT NULL,
  match_json text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permission_decisions (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  policy_id text REFERENCES permission_policies(id),
  rule_ids_json text NOT NULL DEFAULT '[]',
  run_id text REFERENCES agent_runs(id),
  tool_id text REFERENCES tool_catalog_items(id),
  effect text NOT NULL,
  reason text NOT NULL,
  approver_ref text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tool_actions (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tool_id text NOT NULL REFERENCES tool_catalog_items(id),
  action text NOT NULL,
  input_json text NOT NULL,
  output_json text,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sandbox_profiles (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  filesystem text NOT NULL,
  network text NOT NULL,
  process text NOT NULL,
  browser text NOT NULL,
  credential_access text NOT NULL,
  timeout_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  root_ref text NOT NULL,
  mounts_json text NOT NULL DEFAULT '[]',
  prompt_refs_json text NOT NULL DEFAULT '[]',
  context_refs_json text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sandbox_leases (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  profile_id text NOT NULL REFERENCES sandbox_profiles(id),
  run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  permission_decision_id text NOT NULL REFERENCES permission_decisions(id),
  status text NOT NULL,
  granted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz
);

CREATE TABLE IF NOT EXISTS browser_profiles (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text REFERENCES agents(id),
  label text NOT NULL,
  storage_state_ref text,
  auth_markers_json text NOT NULL DEFAULT '[]',
  permission_policy_id text REFERENCES permission_policies(id),
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control_http_sessions (
  session_id text PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  external_conversation_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  default_response_mode text NOT NULL DEFAULT 'sse',
  default_webhook_id text,
  external_ref_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, external_conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_control_http_sessions_external_ref
  ON control_http_sessions USING gin ((external_ref_json::jsonb));

CREATE INDEX IF NOT EXISTS idx_control_http_sessions_chat_jid
  ON control_http_sessions ((external_ref_json::jsonb->>'chatJid'));

CREATE TABLE IF NOT EXISTS control_http_response_routes (
  session_id text NOT NULL REFERENCES control_http_sessions(session_id) ON DELETE CASCADE,
  thread_id text NOT NULL DEFAULT '',
  response_mode text NOT NULL,
  webhook_id text,
  correlation_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, thread_id)
);

CREATE TABLE IF NOT EXISTS control_http_events (
  event_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL,
  session_id text REFERENCES control_http_sessions(session_id) ON DELETE SET NULL,
  job_id text,
  run_id text,
  trigger_id text,
  correlation_id text,
  actor text NOT NULL,
  payload text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_control_http_events_session_event
  ON control_http_events(session_id, event_id);

CREATE INDEX IF NOT EXISTS idx_control_http_events_run
  ON control_http_events(run_id, event_id);

CREATE TABLE IF NOT EXISTS control_http_webhooks (
  webhook_id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  secret text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, name)
);

CREATE TABLE IF NOT EXISTS control_http_webhook_deliveries (
  delivery_id text PRIMARY KEY,
  webhook_id text NOT NULL REFERENCES control_http_webhooks(webhook_id) ON DELETE CASCADE,
  event_id integer NOT NULL REFERENCES control_http_events(event_id) ON DELETE CASCADE,
  status text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_control_http_webhook_deliveries_due
  ON control_http_webhook_deliveries(status, next_attempt_at);
