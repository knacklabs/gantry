import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { App, AppId } from '../../../../domain/app/app.js';
import type { Agent } from '../../../../domain/agent/agent.js';
import type { Conversation } from '../../../../domain/conversation/conversation.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';

function safeIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:@-]/g, '_');
}

function allowlistRowId(
  agentId: string,
  conversationId: string,
  externalUserId: string,
): string {
  return `agent-allowlist:${safeIdPart(agentId)}:${safeIdPart(conversationId)}:${safeIdPart(externalUserId)}`;
}

// Replaces the full set of Slack members allowed to converse with this agent
// in this conversation. Mirrors replaceConversationApproverIdentities's
// identity-resolution shape (conversation_participants first, then verified
// user_aliases), but for a DIFFERENT authorization concept: who may message
// the agent at all, not who may approve risky actions.
//
// Unlike the approver table, an EMPTY externalUserIds list here simply means
// "delete all rows" (no sentinel row) — zero rows is the natural, safe
// default meaning "unrestricted," matching today's behaviour for every
// conversation that never configures an allowlist. Never write a sentinel
// that could be misread as "block everyone."
export async function replaceAgentConversationAllowlist(
  db: CanonicalDb,
  input: {
    appId: App['id'];
    agentId: Agent['id'];
    conversationId: Conversation['id'];
    externalUserIds: string[];
    updatedAt: string;
  },
  executor?: CanonicalExecutor,
): Promise<void> {
  const replace = async (tx: CanonicalExecutor) => {
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
          throw new Error('Allowlist member identity is ambiguous.');
        }
        identities.set(alias.externalUserId, {
          aliasId: alias.aliasId,
          personId: alias.personId,
        });
      }

      const unresolved = externalUserIds.filter((id) => !identities.has(id));
      if (unresolved.length) {
        throw new Error(
          `Allowlist member identities could not be resolved: ${unresolved.join(', ')}`,
        );
      }
    }
    await tx
      .delete(pgSchema.agentConversationAllowlistPostgres)
      .where(
        and(
          eq(pgSchema.agentConversationAllowlistPostgres.appId, input.appId),
          eq(
            pgSchema.agentConversationAllowlistPostgres.agentId,
            input.agentId,
          ),
          eq(
            pgSchema.agentConversationAllowlistPostgres.conversationId,
            input.conversationId,
          ),
        ),
      );
    if (!externalUserIds.length) return;
    await tx.insert(pgSchema.agentConversationAllowlistPostgres).values(
      externalUserIds.map((externalUserId) => ({
        ...(identities.get(externalUserId) ?? {}),
        id: allowlistRowId(input.agentId, input.conversationId, externalUserId),
        appId: input.appId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        externalUserId,
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
      })),
    );
  };
  if (executor) {
    await replace(executor);
    return;
  }
  await db.transaction(replace);
}

// Default-allow: a conversation with zero allowlist rows is unrestricted —
// this is what keeps every conversation that has never configured an
// allowlist working exactly as it does today.
export async function isAgentConversationSenderAllowed(
  db: CanonicalDb,
  input: {
    appId: AppId;
    agentId: Agent['id'];
    conversationId: Conversation['id'];
    externalUserId: string;
  },
): Promise<boolean> {
  const rows = await db
    .select({
      externalUserId:
        pgSchema.agentConversationAllowlistPostgres.externalUserId,
    })
    .from(pgSchema.agentConversationAllowlistPostgres)
    .where(
      and(
        eq(pgSchema.agentConversationAllowlistPostgres.appId, input.appId),
        eq(pgSchema.agentConversationAllowlistPostgres.agentId, input.agentId),
        eq(
          pgSchema.agentConversationAllowlistPostgres.conversationId,
          input.conversationId,
        ),
      ),
    );
  if (rows.length === 0) return true;
  return rows.some((row) => row.externalUserId === input.externalUserId);
}
