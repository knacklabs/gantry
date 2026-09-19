import { and, eq, isNull, sql } from 'drizzle-orm';

import type { AgentId } from '../../../../../domain/agent/agent.js';
import type { AppId } from '../../../../../domain/app/app.js';
import type { ConversationId } from '../../../../../domain/conversation/conversation.js';
import type { ProviderAccountId } from '../../../../../domain/provider/provider.js';
import type { CanonicalDb } from '../canonical-graph-repository.postgres.js';
import { PostgresCanonicalGraphRepository } from '../canonical-graph-repository.postgres.js';
import { replaceConversationApproverIdentities } from '../conversation-approver-identities.postgres.js';
import { stableId } from '../person-identity-mappers.postgres.js';
import * as schema from '../../schema/schema.js';

export class OnboardingAssignmentRepository {
  constructor(private readonly db: CanonicalDb) {}

  async bindWorkAssignment(input: {
    appId: AppId;
    userId: string;
    agentId: AgentId;
    providerAccountId: ProviderAccountId;
    conversationId: ConversationId;
    approverExternalUserId: string;
    approverDisplayName: string;
  }): Promise<{ approverPersonId: string; version: number }> {
    const now = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      const [deployment] = await tx
        .select()
        .from(schema.onboardingDeploymentsPostgres)
        .where(
          and(
            eq(schema.onboardingDeploymentsPostgres.appId, input.appId),
            eq(schema.onboardingDeploymentsPostgres.userId, input.userId),
          ),
        )
        .for('update')
        .limit(1);
      if (
        !deployment ||
        deployment.agentId !== input.agentId ||
        deployment.providerAccountId !== input.providerAccountId
      ) {
        throw new Error('Onboarding deployment changed; reload and retry.');
      }

      const [conversation] = await tx
        .select({
          providerAccountId: schema.conversationsPostgres.providerAccountId,
          title: schema.conversationsPostgres.title,
        })
        .from(schema.conversationsPostgres)
        .where(
          and(
            eq(schema.conversationsPostgres.appId, input.appId),
            eq(schema.conversationsPostgres.id, input.conversationId),
          ),
        )
        .limit(1);
      const [providerAccount] = await tx
        .select({
          agentId: schema.providerAccountsPostgres.agentId,
          providerId: schema.providerAccountsPostgres.providerId,
          status: schema.providerAccountsPostgres.status,
        })
        .from(schema.providerAccountsPostgres)
        .where(
          and(
            eq(schema.providerAccountsPostgres.appId, input.appId),
            eq(schema.providerAccountsPostgres.id, input.providerAccountId),
          ),
        )
        .limit(1);
      if (
        !conversation ||
        conversation.providerAccountId !== input.providerAccountId ||
        !providerAccount ||
        providerAccount.agentId !== input.agentId ||
        providerAccount.status !== 'active'
      ) {
        throw new Error(
          'Conversation, provider account, and employee ownership do not match.',
        );
      }

      const approverPersonId = await new PostgresCanonicalGraphRepository(
        this.db,
      ).ensureParticipant(
        {
          appId: input.appId,
          conversationId: input.conversationId,
          providerId: providerAccount.providerId,
          providerAccountId: input.providerAccountId,
          externalUserId: input.approverExternalUserId,
          displayName: input.approverDisplayName,
          timestamp: now,
        },
        tx,
      );
      if (!approverPersonId) {
        throw new Error(
          'The selected provider identity could not be recorded.',
        );
      }
      await tx
        .update(schema.userAliasesPostgres)
        .set({
          verificationStatus: 'verified',
          verifiedAt: now,
          verifiedBy: 'onboarding:provider-membership',
          evidenceJson: { source: 'provider-membership-observation' },
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.userAliasesPostgres.appId, input.appId),
            eq(schema.userAliasesPostgres.provider, providerAccount.providerId),
            eq(
              schema.userAliasesPostgres.providerAccountId,
              input.providerAccountId,
            ),
            eq(
              schema.userAliasesPostgres.externalUserId,
              input.approverExternalUserId,
            ),
            isNull(schema.userAliasesPostgres.retiredAt),
          ),
        );
      await replaceConversationApproverIdentities(
        this.db,
        {
          appId: input.appId,
          conversationId: input.conversationId,
          externalUserIds: [input.approverExternalUserId],
          updatedAt: now,
        },
        tx,
      );

      const [existingInstall] = await tx
        .select({ id: schema.conversationInstallsPostgres.id })
        .from(schema.conversationInstallsPostgres)
        .where(
          and(
            eq(schema.conversationInstallsPostgres.appId, input.appId),
            eq(schema.conversationInstallsPostgres.agentId, input.agentId),
            eq(
              schema.conversationInstallsPostgres.conversationId,
              input.conversationId,
            ),
            isNull(schema.conversationInstallsPostgres.threadId),
            sql`${schema.conversationInstallsPostgres.id} not like 'conversation-route:%'`,
          ),
        )
        .limit(1);
      const installId =
        existingInstall?.id ??
        stableId('conversation-install', [
          input.appId,
          input.agentId,
          input.conversationId,
        ]);
      await tx
        .insert(schema.conversationInstallsPostgres)
        .values({
          id: installId,
          appId: input.appId,
          agentId: input.agentId,
          providerAccountId: input.providerAccountId,
          conversationId: input.conversationId,
          threadId: null,
          displayName: conversation.title ?? input.conversationId,
          status: 'active',
          senderPolicy: 'provider_native',
          controlPolicy: 'conversation_approvers',
          memoryScope: 'conversation',
          memorySubjectJson: JSON.stringify({
            kind: 'conversation',
            appId: input.appId,
            conversationId: input.conversationId,
          }),
          permissionPolicyIdsJson: '[]',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.conversationInstallsPostgres.id,
          set: {
            providerAccountId: input.providerAccountId,
            displayName: conversation.title ?? input.conversationId,
            status: 'active',
            updatedAt: now,
          },
        });

      const version =
        deployment.conversationId === input.conversationId &&
        deployment.approverPersonId === approverPersonId
          ? deployment.version
          : deployment.version + 1;
      await tx
        .update(schema.onboardingDeploymentsPostgres)
        .set({
          conversationId: input.conversationId,
          approverPersonId,
          desiredStateRevision: null,
          currentStep: 4,
          state: 'projection_pending',
          readyAt: null,
          version,
          updatedAt: now,
        })
        .where(eq(schema.onboardingDeploymentsPostgres.id, deployment.id));

      return { approverPersonId, version };
    });
  }
}
