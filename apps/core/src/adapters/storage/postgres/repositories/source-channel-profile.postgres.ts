import { and, desc, eq } from 'drizzle-orm';
import type { RequestSourceAnswer } from '@gantry/contracts';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { fail, hash } from './source-answer-base.postgres.js';
import * as s from '../schema/schema.js';
export async function configureSourceChannelProfile(
  db: CanonicalDb,
  appId: string,
  agentId: string,
  profile: NonNullable<RequestSourceAnswer['executionProfile']>,
  concurrency: number,
) {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(s.agentsPostgres)
      .where(
        and(
          eq(s.agentsPostgres.id, agentId),
          eq(s.agentsPostgres.appId, appId),
        ),
      )
      .for('update');
    if (!agent) fail('Agent not found in app');
    let [config] = await tx
      .select()
      .from(s.agentConfigVersionsPostgres)
      .where(
        eq(s.agentConfigVersionsPostgres.id, agent!.currentConfigVersionId!),
      );
    if (!config && !agent!.currentConfigVersionId) {
      [config] = await tx
        .select()
        .from(s.agentConfigVersionsPostgres)
        .where(
          and(
            eq(s.agentConfigVersionsPostgres.appId, appId),
            eq(s.agentConfigVersionsPostgres.agentId, agentId),
          ),
        )
        .orderBy(desc(s.agentConfigVersionsPostgres.version))
        .limit(1);
      if (!config) {
        const configId = `config:${agentId}:source:1`;
        const profileId = `llm:source:${appId}:${agentId}`;
        await tx
          .insert(s.llmProfilesPostgres)
          .values({
            id: profileId,
            appId,
            purpose: 'source-answer',
            responseFamily: 'anthropic',
            modelAlias: 'haiku',
            thinkingJson: '{}',
            budgetJson: '{}',
          })
          .onConflictDoNothing();
        [config] = await tx
          .insert(s.agentConfigVersionsPostgres)
          .values({
            id: configId,
            appId,
            agentId,
            version: 1,
            promptProfileRef: 'runtime-default',
            llmProfileId: profileId,
          })
          .returning();
      }
      await tx
        .update(s.agentsPostgres)
        .set({ currentConfigVersionId: config!.id })
        .where(eq(s.agentsPostgres.id, agentId));
    }
    if (!config) fail('Agent configuration absent');
    const limits = JSON.parse(config!.runtimeLimitsJson) as {
      metadata?: Record<string, unknown>;
    };
    const profileHash = hash(profile);
    const effectiveConcurrency = Math.min(
      16,
      Math.max(1, Math.floor(concurrency)),
    );
    if (
      limits.metadata?.sourceChannelProfileHash === profileHash &&
      limits.metadata?.sourceChannelConcurrency === effectiveConcurrency
    )
      return { profileHash, effectiveConcurrency };
    const version = config!.version + 1;
    const id = `${agentId}:source-profile:${version}`;
    await tx.insert(s.agentConfigVersionsPostgres).values({
      ...config!,
      id,
      version,
      runtimeLimitsJson: JSON.stringify({
        ...limits,
        metadata: {
          ...limits.metadata,
          sourceChannelProfileHash: profileHash,
          sourceChannelConcurrency: effectiveConcurrency,
        },
      }),
      createdAt: new Date().toISOString(),
    });
    await tx
      .update(s.agentsPostgres)
      .set({
        currentConfigVersionId: id,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(s.agentsPostgres.id, agentId));
    return { profileHash, effectiveConcurrency };
  });
}
