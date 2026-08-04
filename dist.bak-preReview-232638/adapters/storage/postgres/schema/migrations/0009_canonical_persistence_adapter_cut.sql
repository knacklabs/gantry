-- Canonical Postgres persistence adapter cut.
-- This is a destructive early-stage schema cut with no unsupported local-state import.

DROP TABLE IF EXISTS control_http_webhook_deliveries CASCADE;
DROP TABLE IF EXISTS control_http_webhooks CASCADE;
DROP TABLE IF EXISTS control_http_events CASCADE;
DROP TABLE IF EXISTS control_http_response_routes CASCADE;
DROP TABLE IF EXISTS control_http_sessions CASCADE;
DROP TABLE IF EXISTS registered_groups CASCADE;
DROP TABLE IF EXISTS permission_audit_events CASCADE;
DROP TABLE IF EXISTS sandbox_leases CASCADE;
DROP TABLE IF EXISTS permission_decisions CASCADE;
DROP TABLE IF EXISTS permission_rules CASCADE;
DROP TABLE IF EXISTS permission_policies CASCADE;
DROP TABLE IF EXISTS tool_actions CASCADE;
DROP TABLE IF EXISTS agent_tool_bindings CASCADE;
DROP TABLE IF EXISTS agent_skill_bindings CASCADE;
DROP TABLE IF EXISTS tool_catalog CASCADE;
DROP TABLE IF EXISTS skill_catalog CASCADE;
DROP TABLE IF EXISTS tool_catalog_items CASCADE;
DROP TABLE IF EXISTS skill_catalog_items CASCADE;
DROP TABLE IF EXISTS browser_profiles CASCADE;
DROP TABLE IF EXISTS provider_sessions CASCADE;
DROP TABLE IF EXISTS agent_sessions CASCADE;
DROP TABLE IF EXISTS job_triggers CASCADE;
DROP TABLE IF EXISTS job_runs CASCADE;
DROP TABLE IF EXISTS jobs CASCADE;
DROP TABLE IF EXISTS agent_run_events CASCADE;
DROP TABLE IF EXISTS agent_runs CASCADE;
DROP TABLE IF EXISTS message_attachments CASCADE;
DROP TABLE IF EXISTS message_parts CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS canonical_messages CASCADE;
DROP TABLE IF EXISTS conversation_participants CASCADE;
DROP TABLE IF EXISTS conversation_threads CASCADE;
DROP TABLE IF EXISTS channel_conversations CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS agent_channel_bindings CASCADE;
DROP TABLE IF EXISTS channel_installations CASCADE;
DROP TABLE IF EXISTS channel_providers CASCADE;
DROP TABLE IF EXISTS memory_items CASCADE;
DROP TABLE IF EXISTS memory_subjects CASCADE;
DROP TABLE IF EXISTS agent_config_versions CASCADE;
DROP TABLE IF EXISTS agents CASCADE;
DROP TABLE IF EXISTS llm_profiles CASCADE;
DROP TABLE IF EXISTS user_aliases CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS workspace_snapshots CASCADE;
DROP TABLE IF EXISTS sandbox_profiles CASCADE;
DROP TABLE IF EXISTS runtime_events CASCADE;
DROP TABLE IF EXISTS apps CASCADE;

CREATE TABLE apps (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'human',
  display_name text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_users_app_display_name
  ON users(app_id, display_name);

CREATE TABLE channel_providers (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  capability_flags_json text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_installations (
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

CREATE INDEX idx_channel_installations_provider
  ON channel_installations(app_id, provider_id);

CREATE TABLE user_aliases (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  channel_installation_id text,
  external_user_id text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_user_aliases_provider_external
  ON user_aliases(app_id, provider, channel_installation_id, external_user_id);

CREATE TABLE sandbox_profiles (
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

CREATE TABLE workspace_snapshots (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  root_ref text NOT NULL,
  mounts_json text NOT NULL DEFAULT '[]',
  prompt_refs_json text NOT NULL DEFAULT '[]',
  context_refs_json text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_profiles (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  provider text NOT NULL DEFAULT 'anthropic',
  model_alias text NOT NULL,
  thinking_json text NOT NULL DEFAULT '{}',
  budget_json text NOT NULL DEFAULT '{}',
  credential_profile_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  current_config_version_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_config_versions (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  prompt_profile_ref text NOT NULL,
  llm_profile_id text NOT NULL REFERENCES llm_profiles(id),
  capability_refs_json text NOT NULL DEFAULT '[]',
  source_refs_json text NOT NULL DEFAULT '[]',
  permission_policy_ids_json text NOT NULL DEFAULT '[]',
  sandbox_profile_id text REFERENCES sandbox_profiles(id),
  workspace_snapshot_id text REFERENCES workspace_snapshots(id),
  runtime_limits_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_config_versions_agent_id_version_unique UNIQUE (agent_id, version)
);

CREATE TABLE channel_conversations (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  channel_installation_id text NOT NULL,
  external_ref_json text,
  kind text NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_channel_conversations_installation
  ON channel_conversations(channel_installation_id);

CREATE TABLE conversation_threads (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES channel_conversations(id) ON DELETE CASCADE,
  external_ref_json text,
  title text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversation_threads_conversation
  ON conversation_threads(conversation_id);

CREATE TABLE conversation_participants (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES channel_conversations(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  external_user_id text,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversation_participants_conversation
  ON conversation_participants(conversation_id, user_id);

CREATE TABLE agent_channel_bindings (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel_installation_id text NOT NULL REFERENCES channel_installations(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES channel_conversations(id) ON DELETE CASCADE,
  thread_id text REFERENCES conversation_threads(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  trigger_pattern text,
  requires_trigger boolean NOT NULL DEFAULT true,
  is_admin_binding boolean NOT NULL DEFAULT false,
  memory_subject_json text NOT NULL,
  workspace_snapshot_id text REFERENCES workspace_snapshots(id),
  permission_policy_ids_json text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_channel_bindings_conversation
  ON agent_channel_bindings(conversation_id, thread_id);

CREATE TABLE messages (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  channel_provider text NOT NULL,
  channel_installation_id text NOT NULL REFERENCES channel_installations(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES channel_conversations(id) ON DELETE CASCADE,
  thread_id text REFERENCES conversation_threads(id) ON DELETE CASCADE,
  external_message_id text,
  external_ref_json text,
  direction text NOT NULL,
  sender_user_id text,
  sender_display_name text,
  trust text NOT NULL,
  created_at timestamptz NOT NULL,
  received_at timestamptz
);

CREATE INDEX idx_messages_conversation_cursor
  ON messages(conversation_id, thread_id, created_at, id);

CREATE UNIQUE INDEX idx_messages_external_redelivery_unique
  ON messages(channel_provider, channel_installation_id, conversation_id, thread_id, external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE TABLE message_parts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  kind text NOT NULL,
  payload_json text NOT NULL,
  CONSTRAINT message_parts_message_id_ordinal_unique UNIQUE (message_id, ordinal)
);

CREATE TABLE message_attachments (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind text NOT NULL,
  content_type text,
  size_bytes integer,
  external_ref_json text,
  storage_ref text,
  trust text NOT NULL
);

CREATE TABLE browser_profiles (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text REFERENCES agents(id),
  label text NOT NULL,
  storage_state_ref text,
  auth_markers_json text NOT NULL DEFAULT '[]',
  permission_policy_id text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_sessions (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id text REFERENCES channel_conversations(id),
  thread_id text REFERENCES conversation_threads(id),
  job_id text,
  user_id text,
  latest_provider_session_id text,
  status text NOT NULL DEFAULT 'active',
  model_override text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  reset_at timestamptz
);

CREATE INDEX idx_agent_sessions_owner
  ON agent_sessions(app_id, agent_id, conversation_id, thread_id, user_id);

CREATE TABLE provider_sessions (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_session_id text NOT NULL,
  sandbox_id text REFERENCES sandbox_profiles(id),
  workspace_snapshot_id text REFERENCES workspace_snapshots(id),
  browser_profile_id text REFERENCES browser_profiles(id),
  provider_ref_json text NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_provider_sessions_external
  ON provider_sessions(provider, external_session_id);

CREATE TABLE agent_runs (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  config_version_id text NOT NULL REFERENCES agent_config_versions(id),
  session_id text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  conversation_id text REFERENCES channel_conversations(id),
  thread_id text REFERENCES conversation_threads(id),
  message_id text REFERENCES messages(id),
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

CREATE TABLE agent_run_events (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload_json text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX idx_agent_run_events_run_cursor
  ON agent_run_events(run_id, created_at, id);

CREATE TABLE jobs (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  conversation_id text REFERENCES channel_conversations(id),
  thread_id text REFERENCES conversation_threads(id),
  created_by_actor_id text NOT NULL,
  created_by_source text NOT NULL,
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

CREATE INDEX idx_jobs_app_status_next_run
  ON jobs(app_id, status, next_run_at);

CREATE TABLE job_runs (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  agent_run_id text REFERENCES agent_runs(id),
  status text NOT NULL,
  scheduled_for timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  result_summary text,
  error_summary text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX idx_job_runs_job
  ON job_runs(job_id, created_at);

CREATE TABLE job_triggers (
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

CREATE TABLE memory_items (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  user_id text,
  conversation_id text,
  thread_id text,
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

CREATE UNIQUE INDEX memory_items_active_unique
  ON memory_items(app_id, agent_id, subject_type, subject_id, kind, key)
  WHERE status = 'active';

CREATE INDEX idx_memory_items_subject_updated
  ON memory_items(app_id, agent_id, subject_type, subject_id, status, updated_at);

CREATE TABLE tool_catalog (
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

CREATE UNIQUE INDEX idx_tool_catalog_app_name
  ON tool_catalog(app_id, name);

CREATE TABLE skill_catalog (
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

CREATE UNIQUE INDEX idx_skill_catalog_app_name_version
  ON skill_catalog(app_id, name, version);

CREATE TABLE agent_tool_bindings (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_id text NOT NULL REFERENCES tool_catalog(id) ON DELETE CASCADE,
  config_version_id text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_agent_tool_bindings_unique
  ON agent_tool_bindings(agent_id, tool_id, config_version_id);

CREATE TABLE agent_skill_bindings (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id text NOT NULL REFERENCES skill_catalog(id) ON DELETE CASCADE,
  config_version_id text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_agent_skill_bindings_unique
  ON agent_skill_bindings(app_id, agent_id, skill_id);

CREATE TABLE permission_policies (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permission_rules (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  policy_id text NOT NULL REFERENCES permission_policies(id) ON DELETE CASCADE,
  priority integer NOT NULL,
  effect text NOT NULL,
  match_json text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permission_decisions (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  policy_id text REFERENCES permission_policies(id),
  rule_ids_json text NOT NULL DEFAULT '[]',
  run_id text REFERENCES agent_runs(id),
  tool_id text REFERENCES tool_catalog(id),
  effect text NOT NULL,
  reason text NOT NULL,
  approver_ref text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permission_audit_events (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  decision_id text REFERENCES permission_decisions(id) ON DELETE SET NULL,
  actor_id text,
  event_type text NOT NULL,
  payload_json text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE sandbox_leases (
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

CREATE TABLE runtime_events (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  type text NOT NULL,
  actor_id text,
  payload_json text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE control_http_sessions (
  session_id text PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  external_conversation_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES channel_conversations(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  default_response_mode text NOT NULL DEFAULT 'sse',
  default_webhook_id text,
  external_ref_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, external_conversation_id)
);

CREATE INDEX idx_control_http_sessions_external_ref
  ON control_http_sessions USING gin ((external_ref_json::jsonb));

CREATE INDEX idx_control_http_sessions_chat_jid
  ON control_http_sessions ((external_ref_json::jsonb->>'chatJid'));

CREATE TABLE control_http_response_routes (
  session_id text NOT NULL REFERENCES control_http_sessions(session_id) ON DELETE CASCADE,
  thread_id text NOT NULL DEFAULT '',
  response_mode text NOT NULL,
  webhook_id text,
  correlation_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, thread_id)
);

CREATE TABLE control_http_events (
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

CREATE INDEX idx_control_http_events_session_event
  ON control_http_events(session_id, event_id);

CREATE INDEX idx_control_http_events_run
  ON control_http_events(run_id, event_id);

CREATE TABLE control_http_webhooks (
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

CREATE TABLE control_http_webhook_deliveries (
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

CREATE INDEX idx_control_http_webhook_deliveries_due
  ON control_http_webhook_deliveries(status, next_attempt_at);
