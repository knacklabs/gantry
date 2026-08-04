import type { LiveTurnCommand, LiveTurnCommandRepository, LiveTurnCommandType, LiveTurnLeaseFence } from '../domain/ports/live-turns.js';
/**
 * Owner-side consumer of the durable live-turn command inbox. The owning
 * worker drains pending commands in sequence order and applies each one to
 * its local runner (IPC continuation write, stdin close, stop signal).
 * Apply marking happens after the local side effect succeeds and is fenced by
 * the owner's run lease.
 */
/**
 * Handler failure leaves the command pending so recovery can replay it under a
 * live owner instead of losing already-advanced channel input.
 */
export type LiveTurnCommandApplyResult = 'applied' | 'rejected' | 'retry';
export type LiveTurnCommandHandler = (command: LiveTurnCommand) => Promise<LiveTurnCommandApplyResult> | LiveTurnCommandApplyResult;
export type LiveTurnCommandHandlers = Partial<Record<LiveTurnCommandType, LiveTurnCommandHandler>>;
export interface LiveTurnCommandPump {
    /** Drain pending commands once; resolves to the number applied. */
    drain(): Promise<number>;
}
export declare function createLiveTurnCommandPump(input: {
    liveTurns: Pick<LiveTurnCommandRepository, 'listPendingLiveTurnCommands' | 'isLiveTurnCommandFenceActive' | 'markLiveTurnCommandApplied' | 'markLiveTurnCommandRejected'>;
    turnId: string;
    fence: LiveTurnLeaseFence;
    handlers: LiveTurnCommandHandlers;
    canApplyCommand?: (command: LiveTurnCommand) => boolean;
    batchLimit?: number;
    onError?: (err: unknown, command: LiveTurnCommand) => void;
}): LiveTurnCommandPump;
