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

    for (const tool of [
      { id: 'tool:memory', name: 'memory', risk: 'low' },
      { id: 'tool:messaging', name: 'messaging', risk: 'medium' },
      { id: 'tool:browser', name: 'browser', risk: 'medium' },
      { id: 'tool:shell', name: 'shell', risk: 'high' },
    ]) {
      await tx
        .insert(pgSchema.toolCatalogPostgres)
        .values({
          id: tool.id,
          appId: DEFAULT_APP_ID,
          name: tool.name,
          risk: tool.risk,
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
        })
        .onConflictDoNothing();
    }
  });
}
