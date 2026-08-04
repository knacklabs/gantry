import type { LiveTurnCommand, LiveTurnCommandAppendInput, LiveTurnCommandAppendResult, LiveTurnCommandNotifier } from '../../../../domain/ports/live-turns.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb, CanonicalExecutor } from './canonical-graph-repository.postgres.js';
export type LiveTurnCommandRow = typeof pgSchema.liveTurnCommandsPostgres.$inferSelect;
export declare function toLiveTurnCommand(row: LiveTurnCommandRow): LiveTurnCommand;
export declare function findLiveTurnCommandByIdempotencyKey(db: CanonicalDb, input: {
    liveTurnId: string;
    idempotencyKey: string;
}): Promise<LiveTurnCommand | null>;
export declare function appendLiveTurnCommand(db: CanonicalDb, commandNotifier: LiveTurnCommandNotifier | undefined, input: LiveTurnCommandAppendInput): Promise<LiveTurnCommandAppendResult>;
export declare function appendLiveTurnCommandInTransaction(db: CanonicalExecutor, input: LiveTurnCommandAppendInput, now?: string): Promise<LiveTurnCommandAppendResult>;
