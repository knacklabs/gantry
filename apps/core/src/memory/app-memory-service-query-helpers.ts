import { nowIso as currentIso } from '../shared/time/datetime.js';

export function nowIso(): string {
  return currentIso();
}

export async function withStatementTimeout<T>(
  db: any,
  timeoutMs: number | undefined,
  statementTimeoutSql: (timeoutMs: number) => unknown,
  work: (db: any) => Promise<T>,
): Promise<T> {
  const boundedTimeoutMs = normalizeStatementTimeoutMs(timeoutMs);
  if (boundedTimeoutMs === undefined) {
    return work(db);
  }
  return db.transaction(async (tx: any) => {
    await tx.execute(statementTimeoutSql(boundedTimeoutMs));
    return work(tx);
  });
}

function normalizeStatementTimeoutMs(
  timeoutMs: number | undefined,
): number | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return undefined;
  return Math.max(1, Math.floor(timeoutMs));
}
