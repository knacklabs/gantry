import { eq, sql } from 'drizzle-orm';

import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';

const DEFAULT_LLM_PROFILE_ID = 'llm:default';
const CONTROL_PROVIDER_ID = 'app';

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
  const providerAccountId = controlInstallationId(appId);
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
      responseFamily: 'anthropic',
      modelAlias: 'opus',
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
      // Do not overwrite name on conflict: synthetic agents already have
      // name === folder, and sessions ensured against a real onboarded agent
      // must not clobber its human-assigned name.
      set: {
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
    .insert(pgSchema.providersPostgres)
    .values({
      id: CONTROL_PROVIDER_ID,
      displayName: 'App',
      capabilityFlagsJson: '[]',
      createdAt: now,
    })
    .onConflictDoNothing();
  await db
    .insert(pgSchema.providerAccountsPostgres)
    .values({
      id: providerAccountId,
      appId,
      agentId,
      providerId: CONTROL_PROVIDER_ID,
      externalIdentityRefJson: JSON.stringify({ adapter: 'app', appId }),
      label: 'App',
      status: 'active',
      runtimeSecretRefsJson: '{}',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pgSchema.providerAccountsPostgres.id,
      set: {
        providerId: CONTROL_PROVIDER_ID,
        agentId,
        externalIdentityRefJson: JSON.stringify({ adapter: 'app', appId }),
        label: 'App',
        status: 'active',
        runtimeSecretRefsJson: '{}',
        updatedAt: now,
      },
    });
  await db
    .insert(pgSchema.conversationsPostgres)
    .values({
      id: conversationId,
      appId,
      providerAccountId: providerAccountId,
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
