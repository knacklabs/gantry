import { and, eq, sql } from 'drizzle-orm';

import type {
  GroupJoinOnboardingRecord,
  GroupJoinOnboardingRepository,
  GroupJoinOnboardingStatus,
} from '../../../../domain/ports/group-join-onboarding.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const table = pgSchema.groupJoinOnboardingPostgres;

export class PostgresGroupJoinOnboardingRepository implements GroupJoinOnboardingRepository {
  constructor(private readonly db: CanonicalDb) {}

  async recordPrompt(input: {
    id: string;
    providerAccountId: string;
    chatJid: string;
    adder: string;
    approver: string;
    promptConversationJid: string;
    promptAgentFolder: string;
    now: string;
  }): Promise<GroupJoinOnboardingRecord> {
    const keepRegistered = sql`${table.status} = 'registered'`;
    const [row] = await this.db
      .insert(table)
      .values({
        ...input,
        status: 'prompted',
        promptedAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [table.providerAccountId, table.chatJid],
        set: {
          id: sql`CASE WHEN ${keepRegistered} THEN ${table.id} ELSE ${input.id} END`,
          status: sql`CASE WHEN ${keepRegistered} THEN ${table.status} ELSE 'prompted' END`,
          adder: sql`CASE WHEN ${keepRegistered} THEN ${table.adder} ELSE ${input.adder} END`,
          approver: sql`CASE WHEN ${keepRegistered} THEN ${table.approver} ELSE ${input.approver} END`,
          promptConversationJid: sql`CASE WHEN ${keepRegistered} THEN ${table.promptConversationJid} ELSE ${input.promptConversationJid} END`,
          promptAgentFolder: sql`CASE WHEN ${keepRegistered} THEN ${table.promptAgentFolder} ELSE ${input.promptAgentFolder} END`,
          promptedAt: sql`CASE WHEN ${keepRegistered} THEN ${table.promptedAt} ELSE ${input.now} END`,
          dismissedAt: sql`CASE WHEN ${keepRegistered} THEN ${table.dismissedAt} ELSE NULL END`,
          leftAt: sql`CASE WHEN ${keepRegistered} THEN ${table.leftAt} ELSE NULL END`,
          updatedAt: input.now,
        },
      })
      .returning();
    if (!row) throw new Error('Failed to record group join onboarding prompt');
    return mapRow(row);
  }

  async getById(id: string): Promise<GroupJoinOnboardingRecord | null> {
    const [row] = await this.db
      .select()
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    return row ? mapRow(row) : null;
  }

  async markDismissed(input: {
    id: string;
    now: string;
  }): Promise<GroupJoinOnboardingRecord | null> {
    const [row] = await this.db
      .update(table)
      .set({
        status: 'dismissed',
        dismissedAt: input.now,
        updatedAt: input.now,
      })
      .where(and(eq(table.id, input.id), eq(table.status, 'prompted')))
      .returning();
    return row ? mapRow(row) : null;
  }

  async markRegistered(input: {
    id: string;
    now: string;
  }): Promise<GroupJoinOnboardingRecord | null> {
    const [row] = await this.db
      .update(table)
      .set({
        status: 'registered',
        registeredAt: input.now,
        updatedAt: input.now,
      })
      .where(and(eq(table.id, input.id), eq(table.status, 'prompted')))
      .returning();
    return row ? mapRow(row) : null;
  }

  async revertRegistered(input: {
    id: string;
    now: string;
  }): Promise<GroupJoinOnboardingRecord | null> {
    const [row] = await this.db
      .update(table)
      .set({
        status: 'prompted',
        registeredAt: null,
        updatedAt: input.now,
      })
      .where(and(eq(table.id, input.id), eq(table.status, 'registered')))
      .returning();
    return row ? mapRow(row) : null;
  }

  async markLeft(input: {
    providerAccountId: string;
    chatJid: string;
    now: string;
  }): Promise<GroupJoinOnboardingRecord | null> {
    const [row] = await this.db
      .update(table)
      .set({ leftAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(table.providerAccountId, input.providerAccountId),
          eq(table.chatJid, input.chatJid),
        ),
      )
      .returning();
    return row ? mapRow(row) : null;
  }
}

function mapRow(row: typeof table.$inferSelect): GroupJoinOnboardingRecord {
  return {
    id: row.id,
    providerAccountId: row.providerAccountId,
    chatJid: row.chatJid,
    status: row.status as GroupJoinOnboardingStatus,
    adder: row.adder,
    approver: row.approver,
    promptConversationJid: row.promptConversationJid,
    promptAgentFolder: row.promptAgentFolder,
    promptedAt: row.promptedAt,
    dismissedAt: row.dismissedAt,
    registeredAt: row.registeredAt,
    leftAt: row.leftAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
