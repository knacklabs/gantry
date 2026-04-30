import { eq, sql } from 'drizzle-orm';

import { nowIso as currentIso } from '../../../../infrastructure/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';

const DEFAULT_LLM_PROFILE_ID = 'llm:default';
const CONTROL_PROVIDER_ID = 'control-http';

function agentIdForFolder(folder: string): string {
  return `agent:${folder || 'default'}`;
}

function controlInstallationId(appId: string): string {
  return `control:${appId}`;
}

function controlConversationId(appId: string, externalConversationId: string) {
  return `control:${appId}:conversation:${externalConversationId}`;
}

export async function ensureControlGraph(
  db: CanonicalExecutor,
  input: {
    appId: string;
    externalConversationId: string;
    externalConversationRef: string;
    agentFolder: string;
    title?: string | null;
  },
) {
  const now = currentIso();
  const appId = input.appId;
  const agentId = agentIdForFolder(input.agentFolder);
  const configId = `config:${agentId}:1`;
  const installationId = controlInstallationId(appId);
  const conversationId = controlConversationId(
    appId,
    input.externalConversationId,
  );
  await db
    .insert(pgSchema.appsPostgres)
    .values({
      id: appId,
      slug: appId,
      name: appId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pgSchema.appsPostgres.id,
      set: { updatedAt: now },
    });
  await db
    .insert(pgSchema.llmProfilesPostgres)
    .values({
      id: DEFAULT_LLM_PROFILE_ID,
      appId,
      purpose: 'default',
      modelAlias: 'runtime-default',
      thinkingJson: '{}',
      budgetJson: '{}',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await db
    .insert(pgSchema.agentsPostgres)
    .values({
      id: agentId,
      appId,
      name: input.agentFolder || 'default',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pgSchema.agentsPostgres.id,
      set: {
        name: input.agentFolder || 'default',
        updatedAt: now,
      },
    });
  await db
    .insert(pgSchema.agentConfigVersionsPostgres)
    .values({
      id: configId,
      appId,
      agentId,
      version: 1,
      promptProfileRef: 'runtime-default',
      llmProfileId: DEFAULT_LLM_PROFILE_ID,
      createdAt: now,
    })
    .onConflictDoNothing();
  await db
    .update(pgSchema.agentsPostgres)
    .set({
      currentConfigVersionId: sql`coalesce(${pgSchema.agentsPostgres.currentConfigVersionId}, ${configId})`,
      updatedAt: now,
    })
    .where(eq(pgSchema.agentsPostgres.id, agentId));
  await db
    .insert(pgSchema.channelProvidersPostgres)
    .values({
      id: CONTROL_PROVIDER_ID,
      displayName: 'Control HTTP',
      capabilityFlagsJson: '[]',
      createdAt: now,
    })
    .onConflictDoNothing();
  await db
    .insert(pgSchema.channelInstallationsPostgres)
    .values({
      id: installationId,
      appId,
      providerId: CONTROL_PROVIDER_ID,
      externalRefJson: JSON.stringify({ adapter: 'control-http', appId }),
      label: 'Control HTTP',
      status: 'active',
      runtimeSecretRefsJson: '[]',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pgSchema.channelInstallationsPostgres.id,
      set: { updatedAt: now },
    });
  await db
    .insert(pgSchema.conversationsPostgres)
    .values({
      id: conversationId,
      appId,
      channelInstallationId: installationId,
      externalRefJson: JSON.stringify({
        externalConversationId: input.externalConversationId,
        externalConversationRef: input.externalConversationRef,
      }),
      kind: 'app',
      title: input.title ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pgSchema.conversationsPostgres.id,
      set: {
        externalRefJson: JSON.stringify({
          externalConversationId: input.externalConversationId,
          externalConversationRef: input.externalConversationRef,
        }),
        title: input.title ?? null,
        updatedAt: now,
      },
    });
  return { agentId, conversationId };
}
