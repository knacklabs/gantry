import { and, eq, isNull } from 'drizzle-orm';
import * as pgSchema from '../schema/schema.js';
const table = pgSchema.groupJoinOnboardingPostgres;
export class PostgresGroupJoinOnboardingRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async recordPrompt(input) {
        // The caller's conversation-route check is the single authority for
        // "already registered" - a join event only reaches recordPrompt when no
        // route exists. A stale 'registered' row (conversation later removed from
        // settings) must be re-prompted, not preserved, or the group could never
        // re-onboard.
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
                id: input.id,
                status: 'prompted',
                adder: input.adder,
                approver: input.approver,
                promptConversationJid: input.promptConversationJid,
                promptAgentFolder: input.promptAgentFolder,
                promptedAt: input.now,
                dismissedAt: null,
                registeredAt: null,
                leftAt: null,
                updatedAt: input.now,
            },
        })
            .returning();
        if (!row)
            throw new Error('Failed to record group join onboarding prompt');
        return mapRow(row);
    }
    async getById(id) {
        const [row] = await this.db
            .select()
            .from(table)
            .where(eq(table.id, id))
            .limit(1);
        return row ? mapRow(row) : null;
    }
    async markDismissed(input) {
        const [row] = await this.db
            .update(table)
            .set({
            status: 'dismissed',
            dismissedAt: input.now,
            updatedAt: input.now,
        })
            // leftAt guard: once the bot was removed from the group, the stale
            // prompt's buttons must settle as "no longer active", not act.
            .where(and(eq(table.id, input.id), eq(table.status, 'prompted'), isNull(table.leftAt)))
            .returning();
        return row ? mapRow(row) : null;
    }
    async markRegistered(input) {
        const [row] = await this.db
            .update(table)
            .set({
            status: 'registered',
            registeredAt: input.now,
            updatedAt: input.now,
        })
            .where(and(eq(table.id, input.id), eq(table.status, 'prompted'), isNull(table.leftAt)))
            .returning();
        return row ? mapRow(row) : null;
    }
    async revertRegistered(input) {
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
    async markLeft(input) {
        const [row] = await this.db
            .update(table)
            .set({ leftAt: input.now, updatedAt: input.now })
            .where(and(eq(table.providerAccountId, input.providerAccountId), eq(table.chatJid, input.chatJid)))
            .returning();
        return row ? mapRow(row) : null;
    }
}
function mapRow(row) {
    return {
        id: row.id,
        providerAccountId: row.providerAccountId,
        chatJid: row.chatJid,
        status: row.status,
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
