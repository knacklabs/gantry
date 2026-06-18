import { and, eq } from 'drizzle-orm';

import type {
  LiveTurnCommand,
  LiveTurnCommandStatus,
  LiveTurnCommandType,
} from '../../../../domain/ports/live-turns.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export type LiveTurnCommandRow =
  typeof pgSchema.liveTurnCommandsPostgres.$inferSelect;

export function toLiveTurnCommand(row: LiveTurnCommandRow): LiveTurnCommand {
  return {
    id: row.id,
    liveTurnId: row.liveTurnId,
    scopeKey: row.scopeKey,
    commandType: row.commandType as LiveTurnCommandType,
    seq: row.seq,
    idempotencyKey: row.idempotencyKey,
    payload: (row.payloadJson ?? {}) as Record<string, unknown>,
    status: row.status as LiveTurnCommandStatus,
    fencingVersion: row.fencingVersion,
    createdByWorkerId: row.createdByWorkerId,
    appliedByWorkerId: row.appliedByWorkerId,
    rejectedReason: row.rejectedReason,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
  };
}

export async function findLiveTurnCommandByIdempotencyKey(
  db: CanonicalDb,
  input: {
    liveTurnId: string;
    idempotencyKey: string;
  },
): Promise<LiveTurnCommand | null> {
  const commands = pgSchema.liveTurnCommandsPostgres;
  const rows = await db
    .select()
    .from(commands)
    .where(
      and(
        eq(commands.liveTurnId, input.liveTurnId),
        eq(commands.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? toLiveTurnCommand(row) : null;
}
