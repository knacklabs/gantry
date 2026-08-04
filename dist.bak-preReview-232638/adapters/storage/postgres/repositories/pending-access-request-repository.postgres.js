import { and, eq, gt, sql } from 'drizzle-orm';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
// A pending request is only counted while unexpired. This bounds the lifetime
// of a row whose approval never resolves (e.g. the runtime crashed mid-prompt)
// so it can never permanently inflate the needs-approval count — no sweeper.
const PENDING_ACCESS_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
function expiryFrom(nowIsoString) {
    return new Date(Date.parse(nowIsoString) + PENDING_ACCESS_REQUEST_TTL_MS).toISOString();
}
export class PostgresPendingAccessRequestsRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insertPending(input) {
        const now = input.now ?? nowIso();
        const expiresAt = expiryFrom(now);
        await this.db
            .insert(pgSchema.pendingAccessRequestsPostgres)
            .values({
            id: input.id,
            appId: input.appId,
            agentId: input.agentId,
            requestedBy: input.requestedBy,
            targetJson: JSON.stringify(input.target ?? {}),
            status: 'pending',
            createdAt: now,
            expiresAt,
        })
            .onConflictDoUpdate({
            target: pgSchema.pendingAccessRequestsPostgres.id,
            set: {
                status: 'pending',
                resolvedAt: null,
                createdAt: now,
                expiresAt,
            },
        });
    }
    async markResolved(input) {
        const now = input.now ?? nowIso();
        await this.db
            .update(pgSchema.pendingAccessRequestsPostgres)
            .set({ status: input.resolution, resolvedAt: now })
            .where(and(eq(pgSchema.pendingAccessRequestsPostgres.appId, input.appId), eq(pgSchema.pendingAccessRequestsPostgres.id, input.id)));
    }
    async countPendingAccessRequests(input) {
        const rows = await this.db
            .select({ count: sql `count(*)` })
            .from(pgSchema.pendingAccessRequestsPostgres)
            .where(and(eq(pgSchema.pendingAccessRequestsPostgres.appId, input.appId), eq(pgSchema.pendingAccessRequestsPostgres.status, 'pending'), gt(pgSchema.pendingAccessRequestsPostgres.expiresAt, sql `now()`)));
        return Number(rows[0]?.count ?? 0);
    }
}
