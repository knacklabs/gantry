import { eq, inArray, sql } from 'drizzle-orm';
import * as pgSchema from '../schema/schema.js';
import { mapSession, } from '../schema/control-plane-canonical.postgres.js';
function uniqueStrings(values) {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
export async function getControlSessionById(db, sessionId) {
    const rows = await db
        .select()
        .from(pgSchema.controlHttpSessionsPostgres)
        .where(eq(pgSchema.controlHttpSessionsPostgres.sessionId, sessionId))
        .limit(1);
    return rows[0] ? mapSession(rows[0]) : undefined;
}
export async function getControlSessionsByIds(db, sessionIds) {
    const uniqueSessionIds = uniqueStrings(sessionIds);
    if (uniqueSessionIds.length === 0)
        return [];
    const rows = await db
        .select()
        .from(pgSchema.controlHttpSessionsPostgres)
        .where(inArray(pgSchema.controlHttpSessionsPostgres.sessionId, uniqueSessionIds));
    return rows.map((row) => mapSession(row));
}
export async function getControlSessionByChatJid(db, chatJid) {
    const rows = await db
        .select()
        .from(pgSchema.controlHttpSessionsPostgres)
        .where(sql `${pgSchema.controlHttpSessionsPostgres.externalRefJson}->>'chatJid' = ${chatJid}`)
        .limit(1);
    return rows[0] ? mapSession(rows[0]) : undefined;
}
export async function getControlSessionsByChatJids(db, chatJids) {
    const uniqueChatJids = uniqueStrings(chatJids);
    if (uniqueChatJids.length === 0)
        return [];
    const rows = await db
        .select()
        .from(pgSchema.controlHttpSessionsPostgres)
        .where(inArray(sql `${pgSchema.controlHttpSessionsPostgres.externalRefJson}->>'chatJid'`, uniqueChatJids));
    return rows.map((row) => mapSession(row));
}
