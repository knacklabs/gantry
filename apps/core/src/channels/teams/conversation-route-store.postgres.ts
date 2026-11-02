import { and, eq, sql } from 'drizzle-orm';

import { getRuntimeStorage } from '../../adapters/storage/postgres/runtime-store.js';

import type {
  TeamsConversationRoute,
  TeamsConversationRouteStore,
} from './conversation-route-store.js';
import { teamsConversationIdFromJid } from './types.js';
import { conversationsPostgres as conversations } from '../../adapters/storage/postgres/schema/schema.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  conversationIdForJid,
  parseJson,
  PostgresCanonicalGraphRepository,
} from '../../adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';

function canonicalJid(jid: string): string {
  const conversationId =
    teamsConversationIdFromJid(jid)?.split(';messageid=')[0];
  if (!conversationId) {
    throw new Error(
      'A Teams conversation JID is required to remember its route.',
    );
  }
  return `teams:${conversationId}`;
}

export class PostgresTeamsConversationRouteStore implements TeamsConversationRouteStore {
  constructor(private readonly db: CanonicalDb) {}

  async upsertForProviderAccounts(input: {
    providerAccountIds: readonly string[];
    route: TeamsConversationRoute;
  }): Promise<void> {
    const jid = canonicalJid(input.route.conversationJid);
    // Only transport-owned fields may be merged into the canonical identity.
    const metadata = JSON.stringify({
      serviceUrl: input.route.serviceUrl,
      tenantId: input.route.tenantId,
      botId: input.route.botId,
      channelId: input.route.channelId,
      conversationType: input.route.conversationType,
    });
    const graph = new PostgresCanonicalGraphRepository(this.db);
    await this.db.transaction(async (tx) => {
      await graph.ensureApp(tx);
      // Consistent order also keeps overlapping alias refreshes from deadlocking.
      for (const providerAccountId of [
        ...new Set(input.providerAccountIds),
      ].sort()) {
        const id = await graph.ensureConversation(
          jid,
          { providerAccountId, channel: 'teams' },
          tx,
        );
        await tx
          .update(conversations)
          .set({
            externalRefJson: sql`(COALESCE(${conversations.externalRefJson}::jsonb, '{}'::jsonb) || ${metadata}::jsonb)::text`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(conversations.id, id),
              eq(conversations.appId, CANONICAL_APP_ID),
              eq(conversations.providerAccountId, providerAccountId),
            ),
          );
      }
    });
  }

  async get(input: {
    providerAccountId: string;
    conversationJid: string;
  }): Promise<TeamsConversationRoute | null> {
    const jid = canonicalJid(input.conversationJid);
    const [row] = await this.db
      .select({ externalRefJson: conversations.externalRefJson })
      .from(conversations)
      .where(
        and(
          eq(
            conversations.id,
            conversationIdForJid(jid, input.providerAccountId),
          ),
          eq(conversations.appId, CANONICAL_APP_ID),
          eq(conversations.providerAccountId, input.providerAccountId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const ref = parseJson<Record<string, unknown>>(row.externalRefJson, {});
    if (
      !ref ||
      typeof ref.serviceUrl !== 'string' ||
      !ref.serviceUrl ||
      typeof ref.tenantId !== 'string' ||
      !ref.tenantId ||
      typeof ref.botId !== 'string' ||
      !ref.botId ||
      typeof ref.channelId !== 'string' ||
      !ref.channelId ||
      !(
        ref.conversationType === null ||
        typeof ref.conversationType === 'string'
      )
    ) {
      return null;
    }
    return {
      conversationJid: jid,
      serviceUrl: ref.serviceUrl,
      tenantId: ref.tenantId,
      botId: ref.botId,
      channelId: ref.channelId,
      conversationType: ref.conversationType,
    };
  }
}

export function getRuntimeTeamsConversationRouteStore(): TeamsConversationRouteStore {
  return new PostgresTeamsConversationRouteStore(
    getRuntimeStorage().service.db,
  );
}
