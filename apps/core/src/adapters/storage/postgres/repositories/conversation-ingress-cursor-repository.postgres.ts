import { and, eq, sql } from 'drizzle-orm';

import type {
  ConversationIngressCursor,
  ConversationIngressCursorRepository,
} from '../../../../domain/ports/conversation-ingress-cursor.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

type CursorRow =
  typeof pgSchema.conversationIngressCursorsPostgres.$inferSelect;

function mapCursor(row: CursorRow): ConversationIngressCursor {
  return {
    providerAccountId: row.providerAccountId,
    conversationId: row.conversationId,
    ...(row.coveredThroughExternalId
      ? { coveredThroughExternalId: row.coveredThroughExternalId }
      : {}),
    coveredThroughTimestamp: new Date(
      row.coveredThroughTimestamp,
    ).toISOString(),
    version: row.version,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export class PostgresConversationIngressCursorRepository implements ConversationIngressCursorRepository {
  constructor(private readonly db: CanonicalDb) {}

  async get(
    input: Parameters<ConversationIngressCursorRepository['get']>[0],
  ): Promise<ConversationIngressCursor | null> {
    const cursors = pgSchema.conversationIngressCursorsPostgres;
    const rows = await this.db
      .select()
      .from(cursors)
      .where(
        and(
          eq(cursors.providerAccountId, input.providerAccountId),
          eq(cursors.conversationId, input.conversationId),
        ),
      )
      .limit(1);
    return rows[0] ? mapCursor(rows[0]) : null;
  }

  async advance(
    input: Parameters<ConversationIngressCursorRepository['advance']>[0],
  ): ReturnType<ConversationIngressCursorRepository['advance']> {
    const cursors = pgSchema.conversationIngressCursorsPostgres;
    const rows = await this.db
      .insert(cursors)
      .values({
        providerAccountId: input.providerAccountId,
        conversationId: input.conversationId,
        coveredThroughExternalId: input.coveredThroughExternalId ?? null,
        coveredThroughTimestamp: input.coveredThroughTimestamp,
        version: 1,
        updatedAt: input.updatedAt,
      })
      .onConflictDoUpdate({
        target: [cursors.providerAccountId, cursors.conversationId],
        set: {
          coveredThroughExternalId: input.coveredThroughExternalId ?? null,
          coveredThroughTimestamp: input.coveredThroughTimestamp,
          version: sql`${cursors.version} + 1`,
          updatedAt: input.updatedAt,
        },
        setWhere: and(
          eq(cursors.version, input.expectedVersion),
          sql`${cursors.coveredThroughTimestamp} <= ${input.coveredThroughTimestamp}`,
        ),
      })
      .returning();
    if (rows[0]) return { status: 'advanced', cursor: mapCursor(rows[0]) };
    const current = await this.get(input);
    if (!current) {
      throw new Error(
        'Conversation ingress cursor disappeared during advance.',
      );
    }
    return { status: 'stale', cursor: current };
  }
}
