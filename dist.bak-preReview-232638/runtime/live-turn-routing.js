import { continuationSenderMatchesRequiredUser } from './group-queue-policy.js';
/**
 * Route a follow-up message for an active live turn to its owner. Returns
 * 'no_active_turn' when the scope has no non-terminal turn (including the
 * race where it settles mid-append) — the caller starts a new turn instead.
 */
export async function routeLiveContinuation(input) {
    const turn = await input.liveTurns.getActiveLiveTurn({ scope: input.scope });
    if (!turn)
        return { outcome: 'no_active_turn' };
    if (turn.requiredContinuationUserId &&
        !continuationSenderMatchesRequiredUser(input.senderUserIds, turn.requiredContinuationUserId)) {
        return { outcome: 'sender_not_allowed', turn };
    }
    const appended = await input.liveTurns.appendLiveTurnCommand({
        id: input.commandId,
        liveTurnId: turn.id,
        commandType: 'continuation',
        idempotencyKey: input.idempotencyKey,
        payload: {
            text: input.text,
            threadId: input.scope.threadId ?? null,
            ...(input.cursorAfter ? { cursorAfter: input.cursorAfter } : {}),
        },
        createdByWorkerId: input.createdByWorkerId,
        now: input.now,
    });
    if (appended.outcome === 'rejected' ||
        !appended.command ||
        appended.command.status === 'rejected') {
        return { outcome: 'no_active_turn' };
    }
    return { outcome: 'queued_to_owner', turn, command: appended.command };
}
async function routeLiveControlCommand(input) {
    let turn = null;
    if (input.scope) {
        turn = await input.liveTurns.getActiveLiveTurn({ scope: input.scope });
    }
    if (!turn && input.aliasJid) {
        turn = await input.liveTurns.findActiveLiveTurnByStopAlias({
            aliasJid: input.aliasJid,
        });
    }
    if (!turn)
        return { outcome: 'no_active_turn' };
    const appended = await input.liveTurns.appendLiveTurnCommand({
        id: input.commandId,
        liveTurnId: turn.id,
        commandType: input.commandType,
        idempotencyKey: input.idempotencyKey,
        payload: input.payload ?? {},
        createdByWorkerId: input.createdByWorkerId,
        now: input.now,
    });
    if (appended.outcome === 'rejected' || !appended.command) {
        return { outcome: 'no_active_turn' };
    }
    return { outcome: 'queued_to_owner', turn, command: appended.command };
}
/**
 * Route /stop (or a stop-alias hit) to the owning worker. Resolves the
 * scope first, then durable stop aliases registered on the turn.
 */
export async function routeLiveStop(input) {
    return routeLiveControlCommand({
        ...input,
        commandType: 'stop',
        payload: input.requestedBy ? { requestedBy: input.requestedBy } : {},
    });
}
/** Route a close-stdin signal (end of input for the current turn). */
export async function routeLiveCloseStdin(input) {
    return routeLiveControlCommand({ ...input, commandType: 'close_stdin' });
}
