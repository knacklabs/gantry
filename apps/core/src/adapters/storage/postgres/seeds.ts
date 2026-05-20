import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from './schema/schema.js';
import {
  ADMIN_MCP_TOOL_FULL_NAMES,
  adminMcpToolIdForFullName,
} from '../../../shared/admin-mcp-tools.js';

export const DEFAULT_APP_ID = 'default';
export const DEFAULT_AGENT_ID = 'agent:main_agent';
export const DEFAULT_LLM_PROFILE_ID = 'llm:default';
export const DEFAULT_PERMISSION_POLICY_ID = 'permission-policy:default';
export const DEFAULT_SANDBOX_PROFILE_ID = 'sandbox-profile:local-dev';

export async function seedDefaultRuntimeData(
  db: NodePgDatabase<typeof pgSchema>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(pgSchema.appsPostgres)
      .values({
        id: DEFAULT_APP_ID,
        slug: 'personal',
        name: 'Default Personal App',
      })
      .onConflictDoUpdate({
        target: pgSchema.appsPostgres.id,
        set: {
          slug: 'personal',
          name: 'Default Personal App',
          updatedAt: sql`now()`,
        },
      });

    await tx
      .insert(pgSchema.llmProfilesPostgres)
      .values({
        id: DEFAULT_LLM_PROFILE_ID,
        appId: DEFAULT_APP_ID,
        purpose: 'default',
        provider: 'anthropic',
        modelAlias: 'default',
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

    const configVersionId = `config:${DEFAULT_AGENT_ID}:1`;
    await tx
      .insert(pgSchema.agentsPostgres)
      .values({
        id: DEFAULT_AGENT_ID,
        appId: DEFAULT_APP_ID,
        name: 'Personal Agent',
        currentConfigVersionId: configVersionId,
      })
      .onConflictDoUpdate({
        target: pgSchema.agentsPostgres.id,
        set: { currentConfigVersionId: configVersionId, updatedAt: sql`now()` },
      });

    await tx
      .insert(pgSchema.agentConfigVersionsPostgres)
      .values({
        id: configVersionId,
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
        name: 'Default personal policy',
        description: 'Default local development policy seeded by Gantry.',
      })
      .onConflictDoNothing();

    await tx
      .insert(pgSchema.permissionRulesPostgres)
      .values({
        id: 'permission-rule:default:approval-required',
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
          selectable: true,
          status: 'active',
          permissionPolicyId: DEFAULT_PERMISSION_POLICY_ID,
          sandboxProfileId: DEFAULT_SANDBOX_PROFILE_ID,
          adapterRef: `builtin:${tool.name}`,
        })
        .onConflictDoNothing();
    }

    for (const skill of [
      { id: 'skill:memory', name: 'memory' },
      { id: 'skill:scheduler', name: 'scheduler' },
      { id: 'skill:browser', name: 'browser' },
    ]) {
      await tx
        .insert(pgSchema.skillCatalogPostgres)
        .values({
          id: skill.id,
          appId: DEFAULT_APP_ID,
          name: skill.name,
          version: 'builtin',
          status: 'approved',
        })
        .onConflictDoNothing();
    }
  });
}

const DEFAULT_TOOL_CATALOG = [
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
  },
  ...ADMIN_MCP_TOOL_FULL_NAMES.map((name) =>
    hostTool(
      name,
      adminToolDisplayName(name),
      adminToolDescription(name),
      'admin',
      'high',
    ),
  ),
] as const;

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
  } as const;
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
