import { nowIso as currentIso } from '../shared/time/datetime.js';
export function nowIso() {
    return currentIso();
}
export async function withStatementTimeout(db, timeoutMs, statementTimeoutSql, work) {
    const boundedTimeoutMs = normalizeStatementTimeoutMs(timeoutMs);
    if (boundedTimeoutMs === undefined) {
        return work(db);
    }
    return db.transaction(async (tx) => {
        await tx.execute(statementTimeoutSql(boundedTimeoutMs));
        return work(tx);
    });
}
function normalizeStatementTimeoutMs(timeoutMs) {
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs))
        return undefined;
    return Math.max(1, Math.floor(timeoutMs));
}
