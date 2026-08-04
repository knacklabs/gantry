import { and, eq, isNull, sql } from 'drizzle-orm';
import * as pgSchema from '../schema/schema.js';
const table = pgSchema.permissionPromotionCountersPostgres;
export class PostgresPermissionPromotionRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async incrementAndGet(input) {
        const [row] = await this.db
            .insert(table)
            .values({
            appId: input.appId,
            agentFolder: input.agentFolder,
            suggestionKey: input.suggestionKey,
            allowCount: 1,
            lastOfferedAt: null,
            deniedAt: null,
            createdAt: input.nowIso,
            updatedAt: input.nowIso,
        })
            .onConflictDoUpdate({
            target: [table.appId, table.agentFolder, table.suggestionKey],
            set: {
                allowCount: sql `${table.allowCount} + 1`,
                updatedAt: input.nowIso,
            },
        })
            .returning();
        return mapRow(row);
    }
    async get(input) {
        const [row] = await this.db
            .select()
            .from(table)
            .where(and(eq(table.appId, input.appId), eq(table.agentFolder, input.agentFolder), eq(table.suggestionKey, input.suggestionKey)))
            .limit(1);
        return row ? mapRow(row) : null;
    }
    async markOffered(input) {
        const rows = await this.db
            .update(table)
            .set({ lastOfferedAt: input.nowIso, updatedAt: input.nowIso })
            .where(and(eq(table.appId, input.appId), eq(table.agentFolder, input.agentFolder), eq(table.suggestionKey, input.suggestionKey), isNull(table.lastOfferedAt), isNull(table.deniedAt)))
            .returning({ suggestionKey: table.suggestionKey });
        return rows.length === 1;
    }
    async markDenied(input) {
        await this.db
            .insert(table)
            .values({
            appId: input.appId,
            agentFolder: input.agentFolder,
            suggestionKey: input.suggestionKey,
            allowCount: 0,
            lastOfferedAt: null,
            deniedAt: input.nowIso,
            createdAt: input.nowIso,
            updatedAt: input.nowIso,
        })
            .onConflictDoUpdate({
            target: [table.appId, table.agentFolder, table.suggestionKey],
            set: {
                allowCount: 0,
                deniedAt: input.nowIso,
                updatedAt: input.nowIso,
            },
        });
    }
}
function mapRow(row) {
    return {
        ...row,
        lastOfferedAt: row.lastOfferedAt ? toIsoTimestamp(row.lastOfferedAt) : null,
        deniedAt: row.deniedAt ? toIsoTimestamp(row.deniedAt) : null,
        createdAt: toIsoTimestamp(row.createdAt),
        updatedAt: toIsoTimestamp(row.updatedAt),
    };
}
function toIsoTimestamp(value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
