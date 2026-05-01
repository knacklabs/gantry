import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from './schema/schema.js';

export const DEFAULT_APP_ID = 'default';
export const DEFAULT_AGENT_ID = 'agent:personal';
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
        description: 'Default local development policy seeded by MyClaw.',
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

    await tx
      .insert(pgSchema.agentToolBindingsPostgres)
      .values({
        id: `agent-tool-binding:${DEFAULT_AGENT_ID}:tool:Agent`,
        appId: DEFAULT_APP_ID,
        agentId: DEFAULT_AGENT_ID,
        toolId: 'tool:Agent',
        configVersionId,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: pgSchema.agentToolBindingsPostgres.id,
        set: {
          configVersionId,
          status: 'active',
          updatedAt: sql`now()`,
        },
      });

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
  sdkTool('Agent', 'Agent', 'Run a delegated agent task.', 'agent', 'medium'),
  sdkTool(
    'AskUserQuestion',
    'Ask user question',
    'Ask the user for structured input through MyClaw.',
    'agent',
    'low',
  ),
  sdkTool(
    'Bash',
    'Bash',
    'Run shell commands in the configured sandbox.',
    'execution',
    'high',
  ),
  sdkTool(
    'Config',
    'Config',
    'Inspect safe runtime configuration.',
    'admin',
    'high',
  ),
  sdkTool('Edit', 'Edit', 'Edit an existing file.', 'files', 'medium'),
  sdkTool('Read', 'Read', 'Read files from the workspace.', 'files', 'low'),
  sdkTool(
    'Write',
    'Write',
    'Write a file in the workspace.',
    'files',
    'medium',
  ),
  sdkTool('Glob', 'Glob', 'Find files by glob pattern.', 'search', 'low'),
  sdkTool('Grep', 'Grep', 'Search text in files.', 'search', 'low'),
  sdkTool(
    'NotebookEdit',
    'Notebook edit',
    'Edit notebook cells.',
    'files',
    'medium',
  ),
  sdkTool(
    'TaskOutput',
    'Task output',
    'Read output from a delegated task.',
    'agent',
    'low',
  ),
  sdkTool('TaskStop', 'Task stop', 'Stop a delegated task.', 'agent', 'medium'),
  sdkTool(
    'TodoWrite',
    'Todo write',
    'Maintain the agent task list.',
    'agent',
    'low',
  ),
  sdkTool('WebFetch', 'Web fetch', 'Fetch a web URL.', 'web', 'medium'),
  sdkTool('WebSearch', 'Web search', 'Search the web.', 'web', 'medium'),
  sdkTool(
    'ExitPlanMode',
    'Exit plan mode',
    'Leave planning mode after approval.',
    'agent',
    'low',
  ),
  sdkTool(
    'EnterWorktree',
    'Enter worktree',
    'Enter an isolated worktree.',
    'execution',
    'medium',
  ),
  sdkTool(
    'ExitWorktree',
    'Exit worktree',
    'Exit the current worktree.',
    'execution',
    'medium',
  ),
  sdkTool(
    'ListMcpResources',
    'List MCP resources',
    'List resources exposed by approved MCP servers.',
    'mcp',
    'low',
  ),
  sdkTool(
    'ReadMcpResource',
    'Read MCP resource',
    'Read a resource exposed by an approved MCP server.',
    'mcp',
    'low',
  ),
  {
    id: 'tool:Browser',
    name: 'Browser',
    kind: 'browser',
    provider: 'myclaw',
    providerToolName: 'Browser',
    displayName: 'Browser',
    description: 'Use the shared MyClaw browser capability.',
    category: 'web',
    risk: 'medium',
  },
] as const;

function sdkTool(
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
    id: `tool:${name}`,
    name,
    kind: 'anthropic_sdk',
    provider: `anth${'ropic'}`,
    providerToolName: name,
    displayName,
    description,
    category,
    risk,
  } as const;
}
