import type { LiveTurn, LiveTurnCommand, LiveTurnCommandRepository, LiveTurnRepository, LiveTurnScope } from '../domain/ports/live-turns.js';
/**
 * Inbound routing onto the durable live-turn owner inbox. Any worker can
 * receive channel traffic; these helpers append owner commands instead of
 * touching a local runner, so the owning worker applies them wherever it
 * lives. Sequence numbers and idempotency are enforced by the repository.
 */
type LiveTurnRoutingRepository = Pick<LiveTurnRepository, 'getActiveLiveTurn' | 'findActiveLiveTurnByStopAlias'> & Pick<LiveTurnCommandRepository, 'appendLiveTurnCommand'>;
export type LiveContinuationRouteResult = {
    outcome: 'queued_to_owner';
    turn: LiveTurn;
    command: LiveTurnCommand;
} | {
    outcome: 'no_active_turn';
} | {
    outcome: 'sender_not_allowed';
    turn: LiveTurn;
};
/**
 * Route a follow-up message for an active live turn to its owner. Returns
 * 'no_active_turn' when the scope has no non-terminal turn (including the
 * race where it settles mid-append) — the caller starts a new turn instead.
 */
export declare function routeLiveContinuation(input: {
    liveTurns: LiveTurnRoutingRepository;
    scope: LiveTurnScope;
    text: string;
    senderUserIds?: readonly string[] | null;
    commandId: string;
    idempotencyKey: string;
    cursorAfter?: string | null;
    createdByWorkerId?: string | null;
    now?: string;
}): Promise<LiveContinuationRouteResult>;
export type LiveControlRouteResult = {
    outcome: 'queued_to_owner';
    turn: LiveTurn;
    command: LiveTurnCommand;
} | {
    outcome: 'no_active_turn';
};
/**
 * Route /stop (or a stop-alias hit) to the owning worker. Resolves the
 * scope first, then durable stop aliases registered on the turn.
 */
export declare function routeLiveStop(input: {
    liveTurns: LiveTurnRoutingRepository;
    scope?: LiveTurnScope;
    aliasJid?: string;
    commandId: string;
    idempotencyKey: string;
    requestedBy?: string | null;
    createdByWorkerId?: string | null;
    now?: string;
}): Promise<LiveControlRouteResult>;
/** Route a close-stdin signal (end of input for the current turn). */
export declare function routeLiveCloseStdin(input: {
    liveTurns: LiveTurnRoutingRepository;
    scope?: LiveTurnScope;
    aliasJid?: string;
    commandId: string;
    idempotencyKey: string;
    createdByWorkerId?: string | null;
    now?: string;
}): Promise<LiveControlRouteResult>;
export {};
