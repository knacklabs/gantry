import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';

export const appsPostgres = pgTable('apps', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const llmProfilesPostgres = pgTable('llm_profiles', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  modelAlias: text('model_alias').notNull(),
  thinkingJson: text('thinking_json').notNull().default('{}'),
  budgetJson: text('budget_json').notNull().default('{}'),
  credentialProfileRef: text('credential_profile_ref'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const agentsPostgres = pgTable('agents', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  currentConfigVersionId: text('current_config_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const agentConfigVersionsPostgres = pgTable(
  'agent_config_versions',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    promptProfileRef: text('prompt_profile_ref').notNull(),
    llmProfileId: text('llm_profile_id')
      .notNull()
      .references(() => llmProfilesPostgres.id),
    toolIdsJson: text('tool_ids_json').notNull().default('[]'),
    skillIdsJson: text('skill_ids_json').notNull().default('[]'),
    permissionPolicyIdsJson: text('permission_policy_ids_json')
      .notNull()
      .default('[]'),
    sandboxProfileId: text('sandbox_profile_id'),
    workspaceSnapshotId: text('workspace_snapshot_id'),
    runtimeLimitsJson: text('runtime_limits_json').notNull().default('{}'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentVersionIdx: uniqueIndex('idx_agent_config_versions_agent_version').on(
      table.agentId,
      table.version,
    ),
  }),
);

export const channelProvidersPostgres = pgTable('channel_providers', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  capabilityFlagsJson: text('capability_flags_json').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const channelInstallationsPostgres = pgTable('channel_installations', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  providerId: text('provider_id')
    .notNull()
    .references(() => channelProvidersPostgres.id),
  externalRefJson: text('external_ref_json'),
  label: text('label').notNull(),
  status: text('status').notNull().default('active'),
  runtimeSecretRefsJson: text('runtime_secret_refs_json')
    .notNull()
    .default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const conversationsPostgres = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    channelInstallationId: text('channel_installation_id')
      .notNull()
      .references(() => channelInstallationsPostgres.id, {
        onDelete: 'cascade',
      }),
    externalRefJson: text('external_ref_json'),
    kind: text('kind').notNull(),
    title: text('title'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    installationIdx: index('idx_conversations_installation').on(
      table.channelInstallationId,
    ),
  }),
);

export const conversationThreadsPostgres = pgTable(
  'conversation_threads',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    externalRefJson: text('external_ref_json'),
    title: text('title'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    conversationIdx: index('idx_conversation_threads_conversation').on(
      table.conversationId,
    ),
  }),
);

export const agentChannelBindingsPostgres = pgTable(
  'agent_channel_bindings',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
    channelInstallationId: text('channel_installation_id')
      .notNull()
      .references(() => channelInstallationsPostgres.id, {
        onDelete: 'cascade',
      }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(
      () => conversationThreadsPostgres.id,
      {
        onDelete: 'cascade',
      },
    ),
    displayName: text('display_name').notNull(),
    triggerPattern: text('trigger_pattern'),
    requiresTrigger: boolean('requires_trigger').notNull().default(true),
    isAdminBinding: boolean('is_admin_binding').notNull().default(false),
    memorySubjectJson: text('memory_subject_json').notNull(),
    workspaceSnapshotId: text('workspace_snapshot_id'),
    permissionPolicyIdsJson: text('permission_policy_ids_json')
      .notNull()
      .default('[]'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    conversationIdx: index('idx_agent_channel_bindings_conversation').on(
      table.conversationId,
      table.threadId,
    ),
  }),
);

export const canonicalMessagesPostgres = pgTable(
  'canonical_messages',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversationsPostgres.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(
      () => conversationThreadsPostgres.id,
      {
        onDelete: 'cascade',
      },
    ),
    externalRefJson: text('external_ref_json'),
    direction: text('direction').notNull(),
    senderUserId: text('sender_user_id'),
    senderDisplayName: text('sender_display_name'),
    trust: text('trust').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    receivedAt: timestamp('received_at', {
      withTimezone: true,
      mode: 'string',
    }),
  },
  (table) => ({
    conversationCursorIdx: index(
      'idx_canonical_messages_conversation_cursor',
    ).on(table.conversationId, table.threadId, table.createdAt, table.id),
  }),
);

export const messagePartsPostgres = pgTable('message_parts', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => canonicalMessagesPostgres.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  kind: text('kind').notNull(),
  payloadJson: text('payload_json').notNull(),
});

export const messageAttachmentsPostgres = pgTable('message_attachments', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => canonicalMessagesPostgres.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  contentType: text('content_type'),
  sizeBytes: integer('size_bytes'),
  externalRefJson: text('external_ref_json'),
  storageRef: text('storage_ref'),
  trust: text('trust').notNull(),
});

export const agentSessionsPostgres = pgTable('agent_sessions', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').references(
    () => conversationsPostgres.id,
  ),
  threadId: text('thread_id').references(() => conversationThreadsPostgres.id),
  jobId: text('job_id'),
  userId: text('user_id'),
  status: text('status').notNull().default('active'),
  modelOverride: text('model_override'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  resetAt: timestamp('reset_at', { withTimezone: true, mode: 'string' }),
});

export const providerSessionsPostgres = pgTable('provider_sessions', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  agentSessionId: text('agent_session_id')
    .notNull()
    .references(() => agentSessionsPostgres.id, { onDelete: 'cascade' }),
  providerRefJson: text('provider_ref_json').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const agentRunsPostgres = pgTable('agent_runs', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agentsPostgres.id, { onDelete: 'cascade' }),
  configVersionId: text('config_version_id')
    .notNull()
    .references(() => agentConfigVersionsPostgres.id),
  sessionId: text('session_id').references(() => agentSessionsPostgres.id),
  conversationId: text('conversation_id').references(
    () => conversationsPostgres.id,
  ),
  threadId: text('thread_id').references(() => conversationThreadsPostgres.id),
  messageId: text('message_id').references(() => canonicalMessagesPostgres.id),
  jobId: text('job_id'),
  llmProfileId: text('llm_profile_id')
    .notNull()
    .references(() => llmProfilesPostgres.id),
  permissionDecisionIdsJson: text('permission_decision_ids_json')
    .notNull()
    .default('[]'),
  sandboxLeaseId: text('sandbox_lease_id'),
  workspaceSnapshotId: text('workspace_snapshot_id'),
  cause: text('cause').notNull(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
  endedAt: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
  resultSummary: text('result_summary'),
  errorSummary: text('error_summary'),
});

export const agentRunEventsPostgres = pgTable(
  'agent_run_events',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => agentRunsPostgres.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    runCursorIdx: index('idx_agent_run_events_run_cursor').on(
      table.runId,
      table.createdAt,
      table.id,
    ),
  }),
);

export const toolCatalogItemsPostgres = pgTable('tool_catalog_items', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  inputSchemaJson: text('input_schema_json').notNull().default('{}'),
  outputSchemaJson: text('output_schema_json').notNull().default('{}'),
  risk: text('risk').notNull(),
  permissionPolicyId: text('permission_policy_id'),
  sandboxProfileId: text('sandbox_profile_id'),
  adapterRef: text('adapter_ref').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const skillCatalogItemsPostgres = pgTable('skill_catalog_items', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  version: text('version').notNull(),
  promptRefsJson: text('prompt_refs_json').notNull().default('[]'),
  toolIdsJson: text('tool_ids_json').notNull().default('[]'),
  workflowRefsJson: text('workflow_refs_json').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const permissionPoliciesPostgres = pgTable('permission_policies', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const permissionRulesPostgres = pgTable('permission_rules', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  policyId: text('policy_id')
    .notNull()
    .references(() => permissionPoliciesPostgres.id, { onDelete: 'cascade' }),
  priority: integer('priority').notNull(),
  effect: text('effect').notNull(),
  matchJson: text('match_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const permissionDecisionsPostgres = pgTable('permission_decisions', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  policyId: text('policy_id').references(() => permissionPoliciesPostgres.id),
  ruleIdsJson: text('rule_ids_json').notNull().default('[]'),
  runId: text('run_id').references(() => agentRunsPostgres.id),
  toolId: text('tool_id').references(() => toolCatalogItemsPostgres.id),
  effect: text('effect').notNull(),
  reason: text('reason').notNull(),
  approverRef: text('approver_ref'),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const toolActionsPostgres = pgTable('tool_actions', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  toolId: text('tool_id')
    .notNull()
    .references(() => toolCatalogItemsPostgres.id),
  action: text('action').notNull(),
  inputJson: text('input_json').notNull(),
  outputJson: text('output_json'),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const sandboxProfilesPostgres = pgTable('sandbox_profiles', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  filesystem: text('filesystem').notNull(),
  network: text('network').notNull(),
  process: text('process').notNull(),
  browser: text('browser').notNull(),
  credentialAccess: text('credential_access').notNull(),
  timeoutMs: integer('timeout_ms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const workspaceSnapshotsPostgres = pgTable('workspace_snapshots', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  rootRef: text('root_ref').notNull(),
  mountsJson: text('mounts_json').notNull().default('[]'),
  promptRefsJson: text('prompt_refs_json').notNull().default('[]'),
  contextRefsJson: text('context_refs_json').notNull().default('[]'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});

export const sandboxLeasesPostgres = pgTable('sandbox_leases', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  profileId: text('profile_id')
    .notNull()
    .references(() => sandboxProfilesPostgres.id),
  runId: text('run_id')
    .notNull()
    .references(() => agentRunsPostgres.id, { onDelete: 'cascade' }),
  permissionDecisionId: text('permission_decision_id')
    .notNull()
    .references(() => permissionDecisionsPostgres.id),
  status: text('status').notNull(),
  grantedAt: timestamp('granted_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
  expiresAt: timestamp('expires_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true, mode: 'string' }),
});

export const browserProfilesPostgres = pgTable('browser_profiles', {
  id: text('id').primaryKey(),
  appId: text('app_id')
    .notNull()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references(() => agentsPostgres.id),
  label: text('label').notNull(),
  storageStateRef: text('storage_state_ref'),
  authMarkersJson: text('auth_markers_json').notNull().default('[]'),
  permissionPolicyId: text('permission_policy_id').references(
    () => permissionPoliciesPostgres.id,
  ),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .defaultNow(),
});
