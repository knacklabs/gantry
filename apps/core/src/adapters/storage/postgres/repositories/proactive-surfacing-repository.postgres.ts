import { and, eq } from 'drizzle-orm';

import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const table = pgSchema.proactiveSurfacingOptInsPostgres;

export interface ProactiveSurfacingSubject {
  appId: string;
  agentId: string;
  subjectType: string;
  subjectId: string;
}

export interface ProactiveSurfacingOptIn {
  id: string;
  appId: string;
  agentId: string;
  subjectType: string;
  subjectId: string;
  conversationJid: string | null;
  proactiveSurfacingEnabled: boolean;
  enabledAt: string | null;
  optedOutAt: string | null;
  enabledByActorId: string | null;
  optedOutByActorId: string | null;
  createdAt: string;
  updatedAt: string;
}

export class PostgresProactiveSurfacingRepository {
  constructor(private readonly db: CanonicalDb) {}

  async getBySubject(
    subject: ProactiveSurfacingSubject,
  ): Promise<ProactiveSurfacingOptIn | null> {
    const [row] = await this.db
      .select()
      .from(table)
      .where(subjectWhere(subject))
      .limit(1);
    return row ? mapRow(row) : null;
  }

  async setEnabled(input: {
    subject: ProactiveSurfacingSubject;
    id: string;
    conversationJid?: string | null;
    actorId?: string | null;
    nowIso: string;
  }): Promise<ProactiveSurfacingOptIn> {
    const { subject } = input;
    const set: Partial<typeof table.$inferInsert> = {
      proactiveSurfacingEnabled: true,
      enabledAt: input.nowIso,
      optedOutAt: null,
      updatedAt: input.nowIso,
    };
    if (input.conversationJid != null) {
      set.conversationJid = input.conversationJid;
    }
    if (input.actorId != null) {
      set.enabledByActorId = input.actorId;
    }

    const [row] = await this.db
      .insert(table)
      .values({
        id: input.id,
        appId: subject.appId,
        agentId: subject.agentId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        conversationJid: input.conversationJid ?? null,
        proactiveSurfacingEnabled: true,
        enabledAt: input.nowIso,
        optedOutAt: null,
        enabledByActorId: input.actorId ?? null,
        optedOutByActorId: null,
        createdAt: input.nowIso,
        updatedAt: input.nowIso,
      })
      .onConflictDoUpdate({
        target: [
          table.appId,
          table.agentId,
          table.subjectType,
          table.subjectId,
        ],
        set,
      })
      .returning();
    return mapRow(row);
  }

  async setOptedOut(input: {
    subject: ProactiveSurfacingSubject;
    actorId?: string | null;
    nowIso: string;
  }): Promise<ProactiveSurfacingOptIn | null> {
    const [row] = await this.db
      .update(table)
      .set({
        proactiveSurfacingEnabled: false,
        optedOutAt: input.nowIso,
        optedOutByActorId: input.actorId ?? null,
        updatedAt: input.nowIso,
      })
      .where(subjectWhere(input.subject))
      .returning();
    return row ? mapRow(row) : null;
  }
}

function subjectWhere(subject: ProactiveSurfacingSubject) {
  return and(
    eq(table.appId, subject.appId),
    eq(table.agentId, subject.agentId),
    eq(table.subjectType, subject.subjectType),
    eq(table.subjectId, subject.subjectId),
  );
}

function mapRow(row: typeof table.$inferSelect): ProactiveSurfacingOptIn {
  return {
    id: row.id,
    appId: row.appId,
    agentId: row.agentId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    conversationJid: row.conversationJid ?? null,
    proactiveSurfacingEnabled: row.proactiveSurfacingEnabled,
    enabledAt: row.enabledAt ?? null,
    optedOutAt: row.optedOutAt ?? null,
    enabledByActorId: row.enabledByActorId ?? null,
    optedOutByActorId: row.optedOutByActorId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
