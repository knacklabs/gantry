import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { App, AppId } from '../../../../domain/app/app.js';
import type { Conversation } from '../../../../domain/conversation/conversation.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

function safeIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:@-]/g, '_');
}

function channelControlApproverId(
  conversationId: string,
  externalUserId: string,
): string {
  return `channel-control:${safeIdPart(conversationId)}:${safeIdPart(externalUserId)}`;
}

// Real approver IDs cannot be empty, so this row durably records a clear.
const AUTHORITATIVE_EMPTY_APPROVER = '';

export async function resolveConversationApproverPrincipal(
  db: CanonicalDb,
  input: {
    appId: AppId;
    conversationId: Conversation['id'];
    externalUserId: string;
  },
): Promise<{ personId: string; aliasId?: string } | null> {
  const approverRows = await db
    .select({
      personId: pgSchema.conversationApproversPostgres.personId,
      aliasId: pgSchema.conversationApproversPostgres.aliasId,
    })
    .from(pgSchema.conversationApproversPostgres)
    .innerJoin(
      pgSchema.usersPostgres,
      eq(
        pgSchema.conversationApproversPostgres.personId,
        pgSchema.usersPostgres.id,
      ),
    )
    .where(
      and(
        eq(pgSchema.conversationApproversPostgres.appId, input.appId),
        eq(
          pgSchema.conversationApproversPostgres.conversationId,
          input.conversationId,
        ),
        eq(
          pgSchema.conversationApproversPostgres.externalUserId,
          input.externalUserId,
        ),
        eq(pgSchema.usersPostgres.appId, input.appId),
        eq(pgSchema.usersPostgres.kind, 'human'),
        eq(pgSchema.usersPostgres.status, 'active'),
      ),
    )
    .limit(1);
  const approver = approverRows[0];
  if (approver?.personId) {
    return {
      personId: approver.personId,
      ...(approver.aliasId ? { aliasId: approver.aliasId } : {}),
    };
  }

  const participantRows = await db
    .select({ personId: pgSchema.conversationParticipantsPostgres.userId })
    .from(pgSchema.conversationParticipantsPostgres)
    .innerJoin(
      pgSchema.usersPostgres,
      eq(
        pgSchema.conversationParticipantsPostgres.userId,
        pgSchema.usersPostgres.id,
      ),
    )
    .where(
      and(
        eq(pgSchema.conversationParticipantsPostgres.appId, input.appId),
        eq(
          pgSchema.conversationParticipantsPostgres.conversationId,
          input.conversationId,
        ),
        eq(
          pgSchema.conversationParticipantsPostgres.externalUserId,
          input.externalUserId,
        ),
        eq(pgSchema.usersPostgres.appId, input.appId),
        eq(pgSchema.conversationParticipantsPostgres.status, 'active'),
        eq(pgSchema.usersPostgres.kind, 'human'),
        eq(pgSchema.usersPostgres.status, 'active'),
      ),
    )
    .limit(1);
  const participant = participantRows[0];
  return participant?.personId ? { personId: participant.personId } : null;
}

export async function replaceConversationApproverIdentities(
  db: CanonicalDb,
  input: {
    appId: App['id'];
    conversationId: Conversation['id'];
    externalUserIds: string[];
    updatedAt: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const externalUserIds = [...new Set(input.externalUserIds)];
    const identities = new Map<
      string,
      { aliasId?: string; personId: string }
    >();
    if (externalUserIds.length) {
      const [conversation] = await tx
        .select({
          providerAccountId: pgSchema.conversationsPostgres.providerAccountId,
        })
        .from(pgSchema.conversationsPostgres)
        .where(
          and(
            eq(pgSchema.conversationsPostgres.appId, input.appId),
            eq(pgSchema.conversationsPostgres.id, input.conversationId),
          ),
        )
        .limit(1);
      if (!conversation) throw new Error('Conversation was not found.');

      const [providerAccount] = await tx
        .select({
          id: pgSchema.providerAccountsPostgres.id,
          providerId: pgSchema.providerAccountsPostgres.providerId,
        })
        .from(pgSchema.providerAccountsPostgres)
        .where(
          and(
            eq(pgSchema.providerAccountsPostgres.appId, input.appId),
            eq(
              pgSchema.providerAccountsPostgres.id,
              conversation.providerAccountId,
            ),
          ),
        )
        .limit(1);
      if (!providerAccount) throw new Error('Provider account was not found.');

      const participants = await tx
        .select({
          externalUserId:
            pgSchema.conversationParticipantsPostgres.externalUserId,
          personId: pgSchema.conversationParticipantsPostgres.userId,
        })
        .from(pgSchema.conversationParticipantsPostgres)
        .innerJoin(
          pgSchema.usersPostgres,
          and(
            eq(
              pgSchema.conversationParticipantsPostgres.userId,
              pgSchema.usersPostgres.id,
            ),
            eq(
              pgSchema.conversationParticipantsPostgres.appId,
              pgSchema.usersPostgres.appId,
            ),
          ),
        )
        .where(
          and(
            eq(pgSchema.conversationParticipantsPostgres.appId, input.appId),
            eq(
              pgSchema.conversationParticipantsPostgres.conversationId,
              input.conversationId,
            ),
            inArray(
              pgSchema.conversationParticipantsPostgres.externalUserId,
              externalUserIds,
            ),
            eq(pgSchema.conversationParticipantsPostgres.status, 'active'),
            eq(pgSchema.usersPostgres.kind, 'human'),
            eq(pgSchema.usersPostgres.status, 'active'),
          ),
        );
      for (const participant of participants) {
        if (participant.personId) {
          identities.set(participant.externalUserId, {
            personId: participant.personId,
          });
        }
      }

      const aliases = await tx
        .select({
          aliasId: pgSchema.userAliasesPostgres.id,
          externalUserId: pgSchema.userAliasesPostgres.externalUserId,
          personId: pgSchema.userAliasesPostgres.userId,
        })
        .from(pgSchema.userAliasesPostgres)
        .innerJoin(
          pgSchema.usersPostgres,
          and(
            eq(
              pgSchema.userAliasesPostgres.appId,
              pgSchema.usersPostgres.appId,
            ),
            eq(pgSchema.userAliasesPostgres.userId, pgSchema.usersPostgres.id),
          ),
        )
        .where(
          and(
            eq(pgSchema.userAliasesPostgres.appId, input.appId),
            eq(
              pgSchema.userAliasesPostgres.provider,
              providerAccount.providerId,
            ),
            eq(
              pgSchema.userAliasesPostgres.providerAccountId,
              providerAccount.id,
            ),
            inArray(
              pgSchema.userAliasesPostgres.externalUserId,
              externalUserIds,
            ),
            isNull(pgSchema.userAliasesPostgres.retiredAt),
            eq(pgSchema.usersPostgres.kind, 'human'),
            eq(pgSchema.usersPostgres.status, 'active'),
          ),
        );
      for (const alias of aliases) {
        const existing = identities.get(alias.externalUserId);
        if (existing && existing.personId !== alias.personId) {
          throw new Error('Control approver identity is ambiguous.');
        }
        identities.set(alias.externalUserId, {
          aliasId: alias.aliasId,
          personId: alias.personId,
        });
      }

      const unresolved = externalUserIds.filter((id) => !identities.has(id));
      if (unresolved.length) {
        throw new Error(
          `Control approver identities could not be resolved: ${unresolved.join(', ')}`,
        );
      }
    }
    await tx
      .delete(pgSchema.conversationApproversPostgres)
      .where(
        and(
          eq(pgSchema.conversationApproversPostgres.appId, input.appId),
          eq(
            pgSchema.conversationApproversPostgres.conversationId,
            input.conversationId,
          ),
        ),
      );
    await tx.insert(pgSchema.conversationApproversPostgres).values(
      (externalUserIds.length
        ? externalUserIds
        : [AUTHORITATIVE_EMPTY_APPROVER]
      ).map((externalUserId) => ({
        ...(identities.get(externalUserId) ?? {}),
        id: channelControlApproverId(input.conversationId, externalUserId),
        appId: input.appId,
        conversationId: input.conversationId,
        externalUserId,
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
      })),
    );
  });
}
