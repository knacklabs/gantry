import { and, eq, notInArray, sql } from 'drizzle-orm';

import type {
  LiveTurnCommand,
  LiveTurnCommandAppendInput,
  LiveTurnCommandAppendResult,
  LiveTurnCommandNotifier,
  LiveTurnCommandStatus,
  LiveTurnCommandType,
} from '../../../../domain/ports/live-turns.js';
import { LIVE_TURN_TERMINAL_STATES } from '../../../../domain/ports/live-turns.js';
import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import type {
  CanonicalDb,
  CanonicalExecutor,
} from './canonical-graph-repository.postgres.js';
import { isUniqueViolation } from './worker-coordination-lease.postgres.js';

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

const TERMINAL_STATES = [...LIVE_TURN_TERMINAL_STATES];

export async function appendLiveTurnCommand(
  db: CanonicalDb,
  commandNotifier: LiveTurnCommandNotifier | undefined,
  input: LiveTurnCommandAppendInput,
): Promise<LiveTurnCommandAppendResult> {
  const now = input.now ?? currentIso();
  const existing = await findLiveTurnCommandByIdempotencyKey(db, input);
  if (existing) {
    return notifyLiveTurnCommand(commandNotifier, {
      outcome: 'replayed',
      command: existing,
    });
  }
  try {
    const result = await db.transaction((tx) =>
      appendLiveTurnCommandInTransaction(tx, input, now),
    );
    return notifyLiveTurnCommand(commandNotifier, result);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await findLiveTurnCommandByIdempotencyKey(db, input);
    if (!winner) throw err;
    return notifyLiveTurnCommand(commandNotifier, {
      outcome: 'replayed',
      command: winner,
    });
  }
}

export async function appendLiveTurnCommandInTransaction(
  db: CanonicalExecutor,
  input: LiveTurnCommandAppendInput,
  now = input.now ?? currentIso(),
): Promise<LiveTurnCommandAppendResult> {
  const turns = pgSchema.liveTurnsPostgres;
  // Row-locking sequence allocation keeps concurrent append order stable.
  const turn = (
    await db
      .update(turns)
      .set({
        nextCommandSeq: sql`${turns.nextCommandSeq} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(turns.id, input.liveTurnId),
          notInArray(turns.state, TERMINAL_STATES),
        ),
      )
      .returning({
        nextCommandSeq: turns.nextCommandSeq,
        scopeKey: turns.scopeKey,
        fencingVersion: turns.fencingVersion,
      })
  )[0];
  if (!turn) return { outcome: 'rejected', command: null };
  const row: LiveTurnCommandRow = {
    id: input.id,
    liveTurnId: input.liveTurnId,
    scopeKey: turn.scopeKey,
    commandType: input.commandType,
    seq: turn.nextCommandSeq - 1,
    idempotencyKey: input.idempotencyKey,
    payloadJson: input.payload ?? {},
    status: 'pending',
    fencingVersion: turn.fencingVersion,
    createdByWorkerId: input.createdByWorkerId ?? null,
    appliedByWorkerId: null,
    rejectedReason: null,
    createdAt: now,
    appliedAt: null,
  };
  await db.insert(pgSchema.liveTurnCommandsPostgres).values(row);
  return { outcome: 'appended', command: toLiveTurnCommand(row) };
}

async function notifyLiveTurnCommand(
  commandNotifier: LiveTurnCommandNotifier | undefined,
  result: LiveTurnCommandAppendResult,
): Promise<LiveTurnCommandAppendResult> {
  if (result.command) {
    await commandNotifier?.notifyLiveTurnCommand({
      liveTurnId: result.command.liveTurnId,
      commandId: result.command.id,
    });
  }
  return result;
}
