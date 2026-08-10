import { and, eq, isNull, sql } from 'drizzle-orm';

import type {
  GroupJoinOnboardingRecord,
  GroupJoinOnboardingRepository,
  GroupJoinOnboardingStatus,
} from '../../../../domain/ports/group-join-onboarding.js';
import * as pgSchema from '../schema/schema.js';
import {
  PostgresCanonicalGraphRepository,
  type CanonicalDb,
} from './canonical-graph-repository.postgres.js';

const table = pgSchema.groupJoinOnboardingPostgres;

// ponytail: fixed 5-minute claim window; make it configurable only if a
// provider's duplicate-delivery horizon ever proves longer.
const BOOTSTRAP_CLAIM_WINDOW_MS = 5 * 60_000;

export class PostgresGroupJoinOnboardingRepository implements GroupJoinOnboardingRepository {
  constructor(private readonly db: CanonicalDb) {}

  async recordBootstrap(input: {
    id: string;
    providerAccountId: string;
    chatJid: string;
    adder: string;
    approver: string;
    promptConversationJid: string;
    promptAgentFolder: string;
    now: string;
  }): Promise<GroupJoinOnboardingRecord | null> {
    // The caller's conversation-route check is the single authority for
    // "already registered" — a join
    // event only reaches this claim when NO route exists, so ANY stale row
    // here (failed attempt, manual fallback, or a 'registered' row whose
    // settings commit never landed / was later removed) is reclaimable.
    // The ownership window is the only guard: duplicate event bursts and
    // concurrent deliveries inside it collapse to one claim, atomically in
    // this one statement, while a genuinely later re-add retries cleanly.
    const reclaimAfter = new Date(
      Date.parse(input.now) - BOOTSTRAP_CLAIM_WINDOW_MS,
    ).toISOString();
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
          adder: input.adder,
          approver: input.approver,
          status: 'prompted',
          promptedAt: input.now,
          updatedAt: input.now,
        },
        setWhere: sql`${table.updatedAt} < ${reclaimAfter}`,
      })
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
      .where(
        and(
          eq(table.id, input.id),
          eq(table.status, 'prompted'),
          isNull(table.leftAt),
        ),
      )
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

  async hasDirectConversationWithPerson(
    appId: string,
    personId: string,
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: pgSchema.conversationsPostgres.id })
      .from(pgSchema.userAliasesPostgres)
      .innerJoin(
        pgSchema.conversationParticipantsPostgres,
        and(
          eq(
            pgSchema.conversationParticipantsPostgres.appId,
            pgSchema.userAliasesPostgres.appId,
          ),
          eq(
            pgSchema.conversationParticipantsPostgres.userId,
            pgSchema.userAliasesPostgres.userId,
          ),
        ),
      )
      .innerJoin(
        pgSchema.conversationsPostgres,
        and(
          eq(
            pgSchema.conversationsPostgres.appId,
            pgSchema.conversationParticipantsPostgres.appId,
          ),
          eq(
            pgSchema.conversationsPostgres.id,
            pgSchema.conversationParticipantsPostgres.conversationId,
          ),
        ),
      )
      .where(
        and(
          eq(pgSchema.userAliasesPostgres.appId, appId),
          eq(pgSchema.userAliasesPostgres.userId, personId),
          isNull(pgSchema.userAliasesPostgres.retiredAt),
          eq(pgSchema.conversationParticipantsPostgres.status, 'active'),
          eq(pgSchema.conversationsPostgres.kind, 'direct'),
          eq(pgSchema.conversationsPostgres.status, 'active'),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async ensureInstallerParticipant(input: {
    conversationId: string;
    provider: string;
    providerAccountId: string;
    installerExternalId: string;
    now: string;
  }): Promise<void> {
    await new PostgresCanonicalGraphRepository(this.db).ensureParticipant({
      conversationId: input.conversationId,
      providerId: input.provider,
      providerAccountId: input.providerAccountId,
      externalUserId: input.installerExternalId,
      timestamp: input.now,
    });
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
