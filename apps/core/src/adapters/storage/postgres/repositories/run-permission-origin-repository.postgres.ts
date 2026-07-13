import { eq } from 'drizzle-orm';

import type {
  RunPermissionOrigin,
  RunPermissionOriginRepository,
} from '../../../../domain/ports/run-permission-origin.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

const table = pgSchema.runPermissionOriginPostgres;

export class PostgresRunPermissionOriginRepository implements RunPermissionOriginRepository {
  constructor(private readonly db: CanonicalDb) {}

  async upsertRunOrigin(origin: RunPermissionOrigin): Promise<void> {
    const values = {
      runId: origin.runId,
      appId: origin.appId,
      agentFolder: origin.agentFolder,
      targetJid: origin.targetJid ?? null,
      providerAccountId: origin.providerAccountId ?? null,
      threadId: origin.threadId ?? null,
      triggeringSenderId: origin.triggeringSenderId ?? null,
      senderIsApprover: origin.senderIsApprover,
      triggeringMessageTimestamp: origin.triggeringMessageTimestamp ?? null,
      triggeringMessageId: origin.triggeringMessageId ?? null,
      isScheduled: origin.isScheduled,
      createdAt: origin.createdAt,
    };
    await this.db.insert(table).values(values).onConflictDoUpdate({
      target: table.runId,
      set: values,
    });
  }

  async getRunOrigin(runId: string): Promise<RunPermissionOrigin | null> {
    const [row] = await this.db
      .select()
      .from(table)
      .where(eq(table.runId, runId))
      .limit(1);
    return row ? mapRow(row) : null;
  }
}

function mapRow(row: typeof table.$inferSelect): RunPermissionOrigin {
  return {
    runId: row.runId,
    appId: row.appId,
    agentFolder: row.agentFolder,
    targetJid: row.targetJid ?? undefined,
    providerAccountId: row.providerAccountId ?? undefined,
    threadId: row.threadId ?? undefined,
    triggeringSenderId: row.triggeringSenderId ?? undefined,
    senderIsApprover: row.senderIsApprover,
    triggeringMessageTimestamp: row.triggeringMessageTimestamp
      ? toIsoTimestamp(row.triggeringMessageTimestamp)
      : undefined,
    triggeringMessageId: row.triggeringMessageId ?? undefined,
    isScheduled: row.isScheduled,
    createdAt: toIsoTimestamp(row.createdAt),
  };
}

function toIsoTimestamp(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
