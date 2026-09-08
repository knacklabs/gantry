import { and, eq, isNull, ne } from 'drizzle-orm';

import type { ProviderAccount } from '../../../../domain/provider/provider.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
import { stableId } from './person-identity-mappers.postgres.js';

export function hasSameServiceAlias(
  left: ProviderAccount,
  right: ProviderAccount,
): boolean {
  return (
    left.status === 'active' &&
    right.status === 'active' &&
    left.agentId === right.agentId &&
    left.providerId === right.providerId &&
    left.externalIdentityRef?.value === right.externalIdentityRef?.value
  );
}

export async function syncProviderAccountServiceAlias(
  executor: CanonicalExecutor,
  providerAccount: ProviderAccount,
): Promise<void> {
  const externalUserId = providerAccount.externalIdentityRef?.value;
  if (providerAccount.status !== 'active' || !externalUserId) {
    await retireProviderAccountServiceAlias(executor, providerAccount);
    return;
  }
  const servicePersonId = await resolveServicePersonId(
    executor,
    providerAccount,
  );
  const [existing] = await executor
    .select()
    .from(pgSchema.userAliasesPostgres)
    .where(
      and(
        eq(pgSchema.userAliasesPostgres.appId, providerAccount.appId),
        eq(pgSchema.userAliasesPostgres.provider, providerAccount.providerId),
        eq(pgSchema.userAliasesPostgres.providerAccountId, providerAccount.id),
        eq(pgSchema.userAliasesPostgres.externalUserId, externalUserId),
        isNull(pgSchema.userAliasesPostgres.retiredAt),
      ),
    )
    .limit(1);
  if (existing && existing.userId !== servicePersonId) {
    throw new Error(
      'Provider account identity is already assigned to another Person.',
    );
  }
  const values = {
    id: stableId('person-alias', [
      providerAccount.appId,
      providerAccount.providerId,
      providerAccount.id,
      externalUserId,
    ]),
    appId: providerAccount.appId,
    userId: servicePersonId,
    provider: providerAccount.providerId,
    providerAccountId: providerAccount.id,
    externalUserId,
    displayName: providerAccount.label,
    verificationStatus: 'verified' as const,
    verifiedAt: providerAccount.updatedAt,
    verifiedBy: 'system:provider_account',
    evidenceJson: { evidenceType: 'provider_account' },
    createdAt: providerAccount.createdAt,
    updatedAt: providerAccount.updatedAt,
  };
  if (existing) {
    await executor
      .update(pgSchema.userAliasesPostgres)
      .set({
        displayName: values.displayName,
        verificationStatus: values.verificationStatus,
        verifiedAt: values.verifiedAt,
        verifiedBy: values.verifiedBy,
        evidenceJson: values.evidenceJson,
        updatedAt: values.updatedAt,
      })
      .where(eq(pgSchema.userAliasesPostgres.id, existing.id));
  } else {
    await executor.insert(pgSchema.userAliasesPostgres).values(values);
  }
  await executor
    .update(pgSchema.userAliasesPostgres)
    .set({
      retiredAt: providerAccount.updatedAt,
      retiredBy: 'system:provider_account',
      updatedAt: providerAccount.updatedAt,
    })
    .where(
      and(
        eq(pgSchema.userAliasesPostgres.appId, providerAccount.appId),
        eq(pgSchema.userAliasesPostgres.userId, servicePersonId),
        eq(pgSchema.userAliasesPostgres.provider, providerAccount.providerId),
        eq(pgSchema.userAliasesPostgres.providerAccountId, providerAccount.id),
        ne(pgSchema.userAliasesPostgres.externalUserId, externalUserId),
        isNull(pgSchema.userAliasesPostgres.retiredAt),
      ),
    );
}

export async function retireProviderAccountServiceAlias(
  executor: CanonicalExecutor,
  providerAccount: ProviderAccount,
): Promise<void> {
  const externalUserId = providerAccount.externalIdentityRef?.value;
  if (!externalUserId) return;
  const servicePersonId = await resolveServicePersonId(
    executor,
    providerAccount,
  );
  await executor
    .update(pgSchema.userAliasesPostgres)
    .set({
      retiredAt: providerAccount.updatedAt,
      retiredBy: 'system:provider_account',
      updatedAt: providerAccount.updatedAt,
    })
    .where(
      and(
        eq(pgSchema.userAliasesPostgres.appId, providerAccount.appId),
        eq(pgSchema.userAliasesPostgres.userId, servicePersonId),
        eq(pgSchema.userAliasesPostgres.provider, providerAccount.providerId),
        eq(pgSchema.userAliasesPostgres.providerAccountId, providerAccount.id),
        eq(pgSchema.userAliasesPostgres.externalUserId, externalUserId),
        isNull(pgSchema.userAliasesPostgres.retiredAt),
      ),
    );
}

async function resolveServicePersonId(
  executor: CanonicalExecutor,
  providerAccount: ProviderAccount,
): Promise<string> {
  const [existing] = await executor
    .select({ id: pgSchema.usersPostgres.id })
    .from(pgSchema.usersPostgres)
    .where(
      and(
        eq(pgSchema.usersPostgres.appId, providerAccount.appId),
        eq(pgSchema.usersPostgres.agentId, providerAccount.agentId),
        eq(pgSchema.usersPostgres.kind, 'service'),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [agent] = await executor
    .select({
      name: pgSchema.agentsPostgres.name,
      status: pgSchema.agentsPostgres.status,
      createdAt: pgSchema.agentsPostgres.createdAt,
      updatedAt: pgSchema.agentsPostgres.updatedAt,
    })
    .from(pgSchema.agentsPostgres)
    .where(
      and(
        eq(pgSchema.agentsPostgres.appId, providerAccount.appId),
        eq(pgSchema.agentsPostgres.id, providerAccount.agentId),
      ),
    )
    .limit(1);
  if (!agent) throw new Error('Provider account references an unknown Agent.');
  const personId = stableId('person', [
    providerAccount.appId,
    'service',
    providerAccount.agentId,
  ]);
  await executor
    .insert(pgSchema.usersPostgres)
    .values({
      id: personId,
      appId: providerAccount.appId,
      agentId: providerAccount.agentId,
      kind: 'service',
      displayName: agent.name,
      status: agent.status,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    })
    .onConflictDoNothing();
  return personId;
}
