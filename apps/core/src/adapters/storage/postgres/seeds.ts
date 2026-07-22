import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from './schema/schema.js';
import {
  ADMIN_MCP_TOOL_FULL_NAMES,
  DURABLE_SCHEDULER_MCP_TOOL_FULL_NAMES,
  adminMcpToolIdForFullName,
} from '../../../shared/admin-mcp-tools.js';
import {
  GANTRY_FACADE_EXACT_TOOL_NAMES,
  GANTRY_FACADE_INPUT_SCHEMAS,
  type GantryFacadeExactToolName,
} from '../../../shared/agent-tool-references.js';

export const DEFAULT_APP_ID = 'default';
export const DEFAULT_AGENT_ID = 'agent:main_agent';
export const DEFAULT_AGENT_CONFIG_VERSION_ID = `config:${DEFAULT_AGENT_ID}:1`;
export const DEFAULT_LLM_PROFILE_ID = 'llm:default';
export const DEFAULT_PERMISSION_POLICY_ID = 'permission-policy:default';
export const DEFAULT_PERMISSION_RULE_ID =
  'permission-rule:default:approval-required';
export const DEFAULT_SANDBOX_PROFILE_ID = 'sandbox-profile:local-dev';
export const DEFAULT_SKILL_CATALOG = [
  { id: 'skill:memory', name: 'memory' },
  { id: 'skill:scheduler', name: 'scheduler' },
  { id: 'skill:browser', name: 'browser' },
] as const;

export async function seedDefaultRuntimeData(
  db: NodePgDatabase<typeof pgSchema>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(pgSchema.appsPostgres)
      .values({
        id: DEFAULT_APP_ID,
        slug: 'personal',
        name: 'Default Local App',
      })
      .onConflictDoUpdate({
        target: pgSchema.appsPostgres.id,
        set: {
          slug: 'personal',
          name: 'Default Local App',
          updatedAt: sql`now()`,
        },
      });

    await tx
      .insert(pgSchema.llmProfilesPostgres)
      .values({
        id: DEFAULT_LLM_PROFILE_ID,
        appId: DEFAULT_APP_ID,
        purpose: 'default',
        responseFamily: 'anthropic',
        modelAlias: 'opus',
        thinkingJson: '{}',
        budgetJson: '{}',
      })
      .onConflictDoNothing();

    await tx
      .insert(pgSchema.sandboxProfilesPostgres)
      .values({
        id: DEFAULT_SANDBOX_PROFILE_ID,
        appId: DEFAULT_APP_ID,
        name: 'Local development',
        filesystem: 'workspace',
        network: 'enabled',
        process: 'host',
        browser: 'allowed',
        credentialAccess: 'brokered',
        timeoutMs: 300000,
      })
      .onConflictDoNothing();

    await tx
      .insert(pgSchema.agentsPostgres)
      .values({
        id: DEFAULT_AGENT_ID,
        appId: DEFAULT_APP_ID,
        name: 'Default Agent',
        currentConfigVersionId: DEFAULT_AGENT_CONFIG_VERSION_ID,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentsPostgres.id,
        set: {
          currentConfigVersionId: DEFAULT_AGENT_CONFIG_VERSION_ID,
          updatedAt: sql`now()`,
        },
      });

    await tx
      .insert(pgSchema.agentConfigVersionsPostgres)
      .values({
        id: DEFAULT_AGENT_CONFIG_VERSION_ID,
        appId: DEFAULT_APP_ID,
        agentId: DEFAULT_AGENT_ID,
        version: 1,
        promptProfileRef: 'default',
        llmProfileId: DEFAULT_LLM_PROFILE_ID,
        sandboxProfileId: DEFAULT_SANDBOX_PROFILE_ID,
        permissionPolicyIdsJson: JSON.stringify([DEFAULT_PERMISSION_POLICY_ID]),
      })
      .onConflictDoNothing();

    await tx
      .insert(pgSchema.permissionPoliciesPostgres)
      .values({
        id: DEFAULT_PERMISSION_POLICY_ID,
        appId: DEFAULT_APP_ID,
        name: 'Default local policy',
        description: 'Default local development policy seeded by Gantry.',
      })
      .onConflictDoNothing();

    await tx
      .insert(pgSchema.permissionRulesPostgres)
      .values({
        id: DEFAULT_PERMISSION_RULE_ID,
        appId: DEFAULT_APP_ID,
        policyId: DEFAULT_PERMISSION_POLICY_ID,
        priority: 100,
        effect: 'require_approval',
        matchJson: JSON.stringify({ risk: ['write', 'execute', 'network'] }),
      })
      .onConflictDoNothing();

    for (const tool of DEFAULT_TOOL_CATALOG) {
      await tx
        .insert(pgSchema.toolCatalogPostgres)
        .values({
          id: tool.id,
          appId: DEFAULT_APP_ID,
          name: tool.name,
          kind: tool.kind,
          provider: tool.provider,
          providerToolName: tool.providerToolName,
          displayName: tool.displayName,
          description: tool.description,
          category: tool.category,
          risk: tool.risk,
          inputSchemaJson: JSON.stringify(tool.inputSchema ?? {}),
          selectable: true,
          status: 'active',
          permissionPolicyId: DEFAULT_PERMISSION_POLICY_ID,
          sandboxProfileId: DEFAULT_SANDBOX_PROFILE_ID,
          adapterRef: `builtin:${tool.name}`,
        })
        .onConflictDoNothing();
    }

    for (const skill of DEFAULT_SKILL_CATALOG) {
      await tx
        .insert(pgSchema.skillCatalogPostgres)
        .values({
          id: skill.id,
          appId: DEFAULT_APP_ID,
          name: skill.name,
          status: 'installed',
        })
        .onConflictDoNothing();
    }
  });
}

export const DEFAULT_TOOL_CATALOG = [
  {
    id: 'tool:Browser',
    name: 'Browser',
    kind: 'browser',
    provider: 'gantry',
    providerToolName: undefined,
    displayName: 'Browser',
    description: 'Use the shared Gantry browser capability.',
    category: 'web',
    risk: 'medium',
    inputSchema: undefined,
  },
  ...GANTRY_FACADE_EXACT_TOOL_NAMES.map((name) =>
    gantryFacadeTool(
      name,
      gantryFacadeDisplayName(name),
      gantryFacadeDescription(name),
      gantryFacadeCategory(name),
      gantryFacadeRisk(name),
    ),
  ),
  ...ADMIN_MCP_TOOL_FULL_NAMES.map((name) =>
    hostTool(
      name,
      adminToolDisplayName(name),
      adminToolDescription(name),
      'admin',
      'high',
    ),
  ),
  ...DURABLE_SCHEDULER_MCP_TOOL_FULL_NAMES.map((name) =>
    hostTool(
      name,
      schedulerToolDisplayName(name),
      schedulerToolDescription(name),
      'admin',
      schedulerToolRisk(name),
    ),
  ),
] as const;

function gantryFacadeTool(
  name: GantryFacadeExactToolName,
  displayName: string,
  description: string,
  category: 'files' | 'execution' | 'web' | 'agent',
  risk: 'low' | 'medium' | 'high',
) {
  return {
    id: `tool:${name}`,
    name,
    kind: 'host',
    provider: 'gantry',
    providerToolName: undefined,
    displayName,
    description,
    category,
    risk,
    inputSchema: GANTRY_FACADE_INPUT_SCHEMAS[name],
  } as const;
}

function hostTool(
  name: string,
  displayName: string,
  description: string,
  category:
    | 'files'
    | 'search'
    | 'execution'
    | 'web'
    | 'agent'
    | 'mcp'
    | 'channel'
    | 'admin',
  risk: 'low' | 'medium' | 'high',
) {
  return {
    id: adminMcpToolIdForFullName(name),
    name,
    kind: 'host',
    provider: 'gantry',
    providerToolName: undefined,
    displayName,
    description,
    category,
    risk,
    inputSchema: undefined,
  } as const;
}

function gantryFacadeDisplayName(name: GantryFacadeExactToolName): string {
  switch (name) {
    case 'WebSearch':
      return 'Web search';
    case 'WebRead':
      return 'Web read';
    case 'FileSearch':
      return 'File search';
    case 'FileRead':
      return 'File read';
    case 'FileEdit':
      return 'File edit';
    case 'FileWrite':
      return 'File write';
    case 'AgentDelegation':
      return 'Agent delegation';
  }
}

function gantryFacadeDescription(name: GantryFacadeExactToolName): string {
  switch (name) {
    case 'WebSearch':
      return 'Search the public web from a query through the selected execution harness.';
    case 'WebRead':
      return 'Read a known URL through the selected execution harness.';
    case 'FileSearch':
      return 'Search workspace files by path or content. Path mode may use glob-style queries; content mode uses include/exclude globs only.';
    case 'FileRead':
      return 'Read one exact safe relative workspace file path.';
    case 'FileEdit':
      return 'Patch one exact safe relative workspace file path.';
    case 'FileWrite':
      return 'Create or replace one exact safe relative workspace file path.';
    case 'AgentDelegation':
      return 'Delegate work through Gantry-owned task lifecycle wrappers.';
  }
}

function gantryFacadeCategory(
  name: GantryFacadeExactToolName,
): 'files' | 'execution' | 'web' | 'agent' {
  switch (name) {
    case 'WebSearch':
    case 'WebRead':
      return 'web';
    case 'FileSearch':
    case 'FileRead':
    case 'FileEdit':
    case 'FileWrite':
      return 'files';
    case 'AgentDelegation':
      return 'agent';
  }
}

function gantryFacadeRisk(name: GantryFacadeExactToolName) {
  switch (name) {
    case 'FileEdit':
    case 'FileWrite':
      return 'high';
    case 'FileRead':
    case 'WebRead':
    case 'AgentDelegation':
      return 'medium';
    case 'FileSearch':
    case 'WebSearch':
      return 'low';
  }
}

function adminToolDisplayName(name: string): string {
  switch (name) {
    case 'mcp__gantry__settings_desired_state':
      return 'Settings desired state';
    case 'mcp__gantry__request_settings_update':
      return 'Request settings update';
    case 'mcp__gantry__service_restart':
      return 'Service restart';
    case 'mcp__gantry__register_agent':
      return 'Register agent';
    default:
      return name;
  }
}

function adminToolDescription(name: string): string {
  switch (name) {
    case 'mcp__gantry__settings_desired_state':
      return 'Read local desired-state settings before a reviewed settings update.';
    case 'mcp__gantry__request_settings_update':
      return 'Request a reviewed local settings.yaml desired-state update.';
    case 'mcp__gantry__service_restart':
      return 'Restart the Gantry service after validation.';
    case 'mcp__gantry__register_agent':
      return 'Bind a channel conversation to an agent.';
    default:
      return 'Built-in Gantry admin MCP tool.';
  }
}

function schedulerToolDisplayName(name: string): string {
  return name
    .replace(/^mcp__gantry__scheduler_/, 'Scheduler ')
    .replaceAll(/[._-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function schedulerToolDescription(name: string): string {
  switch (name) {
    case 'mcp__gantry__scheduler_run_now':
      return 'Trigger an existing scheduler job for the current authorized workspace.';
    case 'mcp__gantry__scheduler_get_job':
    case 'mcp__gantry__scheduler_list_jobs':
      return 'Inspect scheduler jobs visible to the current authorized workspace.';
    case 'mcp__gantry__scheduler_list_events':
    case 'mcp__gantry__scheduler_wait_for_events':
    case 'mcp__gantry__scheduler_list_runs':
    case 'mcp__gantry__scheduler_get_dead_letter':
      return 'Inspect scheduler run evidence visible to the current authorized workspace.';
    default:
      return 'Inspect scheduler metadata visible to the current authorized workspace.';
  }
}

function schedulerToolRisk(name: string): 'low' | 'medium' | 'high' {
  return name === 'mcp__gantry__scheduler_run_now' ? 'medium' : 'low';
}
