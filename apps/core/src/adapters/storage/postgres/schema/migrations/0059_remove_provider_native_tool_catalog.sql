-- Irreversible: provider-native SDK tools are adapter projections, not durable
-- Gantry capabilities. This migration removes their catalog/binding rows and
-- preserves historical permission decisions with per-app tombstone tool rows.
BEGIN;

CREATE TEMP TABLE provider_native_tool_cleanup_ids (
  id text PRIMARY KEY,
  app_id text NOT NULL
) ON COMMIT DROP;

INSERT INTO provider_native_tool_cleanup_ids (id, app_id)
SELECT id, app_id
FROM tool_catalog
WHERE kind = 'anthropic_sdk'
   OR provider = 'anthropic'
   OR id IN (
     'tool:Agent',
     'tool:Bash',
     'tool:Edit',
     'tool:Read',
     'tool:Write',
     'tool:Glob',
     'tool:Grep',
     'tool:LS',
     'tool:MultiEdit',
     'tool:NotebookEdit',
     'tool:ToolSearch',
     'tool:Skill',
     'tool:WebFetch',
     'tool:WebSearch',
     'tool:AskUserQuestion',
     'tool:SendMessage',
     'tool:CronCreate',
     'tool:CronDelete',
     'tool:RemoteTrigger',
     'tool:ScheduleWakeup',
     'tool:PushNotification',
     'tool:TeamCreate',
     'tool:TeamDelete',
     'tool:Task',
     'tool:TaskOutput',
     'tool:TaskStop',
     'tool:EnterPlanMode',
     'tool:ExitPlanMode',
     'tool:EnterWorktree',
     'tool:ExitWorktree',
     'tool:Monitor',
     'tool:TodoWrite',
     'tool:ListMcpResources',
     'tool:ReadMcpResource'
   )
ON CONFLICT (id) DO NOTHING;

INSERT INTO tool_catalog (
  id,
  app_id,
  name,
  kind,
  provider,
  provider_tool_name,
  display_name,
  description,
  category,
  input_schema_json,
  output_schema_json,
  risk,
  selectable,
  status,
  adapter_ref,
  created_at,
  updated_at
)
SELECT
  'tool:removed-provider-native-sdk:' || md5(app_id),
  app_id,
  'removed_provider_native_sdk_tool',
  'tombstone',
  'gantry',
  NULL,
  'Removed provider-native SDK tool',
  'Historical placeholder for provider-native SDK tools removed from the durable Gantry tool catalog.',
  'audit',
  '{}',
  '{}',
  'low',
  false,
  'removed',
  'removed-provider-native-sdk',
  now(),
  now()
FROM (
  SELECT DISTINCT tc.app_id
  FROM provider_native_tool_cleanup_ids doomed
  JOIN permission_decisions pd ON pd.tool_id = doomed.id
  JOIN tool_catalog tc ON tc.id = doomed.id
) apps_requiring_tombstones
ON CONFLICT (id) DO NOTHING;

UPDATE permission_decisions AS pd
SET tool_id = 'tool:removed-provider-native-sdk:' || md5(doomed.app_id)
FROM provider_native_tool_cleanup_ids doomed
WHERE pd.tool_id = doomed.id;

DELETE FROM agent_tool_bindings
WHERE tool_id IN (
  SELECT id
  FROM provider_native_tool_cleanup_ids
);

DELETE FROM tool_catalog
WHERE id IN (
  SELECT id
  FROM provider_native_tool_cleanup_ids
);

COMMIT;
