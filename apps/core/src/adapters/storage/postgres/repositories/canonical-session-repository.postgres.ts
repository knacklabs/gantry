import { and, eq, ne, or, sql } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import {
  CANONICAL_APP_ID,
  type CanonicalDb,
  json,
  PostgresCanonicalGraphRepository,
} from './canonical-graph-repository.postgres.js';

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export class PostgresCanonicalSessionRepository {
  private readonly graph: PostgresCanonicalGraphRepository;

  constructor(private readonly db: CanonicalDb) {
    this.graph = new PostgresCanonicalGraphRepository(db);
  }

  async getProviderSessionId(scopeKey: string): Promise<string | undefined> {
    const s = pgSchema.agentSessionsPostgres;
    const ps = pgSchema.providerSessionsPostgres;
    const rows = await this.db
      .select({ id: ps.id })
      .from(ps)
      .innerJoin(s, eq(s.id, ps.agentSessionId))
      .where(eq(s.userId, scopeKey))
      .orderBy(sql`${ps.updatedAt} DESC`)
      .limit(1);
    return rows[0]?.id;
  }

  async setProviderSession(input: {
    groupFolder: string;
    scopeKey: string;
    sessionId: string;
  }): Promise<void> {
    const agentSessionId = `agent-session:${input.scopeKey}`;
    await this.db.transaction(async (tx) => {
      const agentId = await this.graph.ensureAgent(
        input.groupFolder,
        input.groupFolder,
        tx,
      );
      await tx
        .insert(pgSchema.agentSessionsPostgres)
        .values({
          id: agentSessionId,
          appId: CANONICAL_APP_ID,
          agentId,
          userId: input.scopeKey,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: pgSchema.agentSessionsPostgres.id,
          set: { status: 'active', updatedAt: sql`now()` },
        });
      await tx
        .select({ id: pgSchema.agentSessionsPostgres.id })
        .from(pgSchema.agentSessionsPostgres)
        .where(eq(pgSchema.agentSessionsPostgres.id, agentSessionId))
        // Serialize provider-session replacement for this agent session.
        .for('update')
        .limit(1);
      await tx
        .delete(pgSchema.providerSessionsPostgres)
        .where(
          and(
            eq(
              pgSchema.providerSessionsPostgres.agentSessionId,
              agentSessionId,
            ),
            ne(pgSchema.providerSessionsPostgres.id, input.sessionId),
          ),
        );
      await tx
        .insert(pgSchema.providerSessionsPostgres)
        .values({
          id: input.sessionId,
          appId: CANONICAL_APP_ID,
          agentSessionId,
          provider: 'anthropic',
          externalSessionId: input.sessionId,
          artifactRef: input.sessionId,
          providerRefJson: json({
            kind: 'runtime_session',
            provider: 'anthropic',
            externalSessionId: input.sessionId,
          }),
          status: 'active',
        })
        .onConflictDoUpdate({
          target: pgSchema.providerSessionsPostgres.id,
          set: {
            agentSessionId,
            provider: 'anthropic',
            externalSessionId: input.sessionId,
            artifactRef: input.sessionId,
            updatedAt: sql`now()`,
          },
        });
      await tx
        .update(pgSchema.agentSessionsPostgres)
        .set({
          latestProviderSessionId: input.sessionId,
          updatedAt: sql`now()`,
        })
        .where(eq(pgSchema.agentSessionsPostgres.id, agentSessionId));
    });
  }

  async deleteScope(scopeKey: string): Promise<void> {
    await this.db
      .delete(pgSchema.agentSessionsPostgres)
      .where(eq(pgSchema.agentSessionsPostgres.userId, scopeKey));
  }

  async deleteGroupFolder(groupFolder: string): Promise<void> {
    await this.db
      .delete(pgSchema.agentSessionsPostgres)
      .where(
        or(
          eq(pgSchema.agentSessionsPostgres.userId, groupFolder),
          sql`${pgSchema.agentSessionsPostgres.userId} LIKE ${`${escapeLikePattern(groupFolder)}::thread:%`} ESCAPE '\\'`,
        ),
      );
  }

  async listSessions(): Promise<
    Array<{ scopeKey: string; sessionId: string }>
  > {
    const s = pgSchema.agentSessionsPostgres;
    const ps = pgSchema.providerSessionsPostgres;
    const rows = await this.db
      .select({ scopeKey: s.userId, sessionId: ps.id })
      .from(ps)
      .innerJoin(
        s,
        and(eq(s.id, ps.agentSessionId), sql`${s.userId} IS NOT NULL`),
      );
    return rows.flatMap((row) =>
      row.scopeKey
        ? [{ scopeKey: row.scopeKey, sessionId: row.sessionId }]
        : [],
    );
  }
}
