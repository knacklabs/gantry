import type {
  LiveTurn,
  LiveTurnCommand,
  LiveTurnCommandRepository,
  LiveTurnRepository,
  LiveTurnScope,
} from '../domain/ports/live-turns.js';
import { continuationSenderMatchesRequiredUser } from './group-queue-policy.js';

/**
 * Inbound routing onto the durable live-turn owner inbox. Any worker can
 * receive channel traffic; these helpers append owner commands instead of
 * touching a local runner, so the owning worker applies them wherever it
 * lives. Sequence numbers and idempotency are enforced by the repository.
 */

type LiveTurnRoutingRepository = Pick<
  LiveTurnRepository,
  'getActiveLiveTurn' | 'findActiveLiveTurnByStopAlias'
> &
  Pick<LiveTurnCommandRepository, 'appendLiveTurnCommand'>;

export type LiveContinuationRouteResult =
  | { outcome: 'queued_to_owner'; turn: LiveTurn; command: LiveTurnCommand }
  | { outcome: 'no_active_turn' }
  | { outcome: 'sender_not_allowed'; turn: LiveTurn };

/**
 * Route a follow-up message for an active live turn to its owner. Returns
 * 'no_active_turn' when the scope has no non-terminal turn (including the
 * race where it settles mid-append) — the caller starts a new turn instead.
 */
export async function routeLiveContinuation(input: {
  liveTurns: LiveTurnRoutingRepository;
  scope: LiveTurnScope;
  text: string;
  senderUserIds?: readonly string[] | null;
  commandId: string;
  idempotencyKey: string;
  cursorAfter?: string | null;
  createdByWorkerId?: string | null;
  now?: string;
}): Promise<LiveContinuationRouteResult> {
  const turn = await input.liveTurns.getActiveLiveTurn({ scope: input.scope });
  if (!turn) return { outcome: 'no_active_turn' };
  if (
    turn.requiredContinuationUserId &&
    !continuationSenderMatchesRequiredUser(
      input.senderUserIds,
      turn.requiredContinuationUserId,
    )
  ) {
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
  if (
    appended.outcome === 'rejected' ||
    !appended.command ||
    appended.command.status === 'rejected'
  ) {
    return { outcome: 'no_active_turn' };
  }
  return { outcome: 'queued_to_owner', turn, command: appended.command };
}

export type LiveControlRouteResult =
  | { outcome: 'queued_to_owner'; turn: LiveTurn; command: LiveTurnCommand }
  | { outcome: 'no_active_turn' };

async function routeLiveControlCommand(input: {
  liveTurns: LiveTurnRoutingRepository;
  commandType: 'stop' | 'close_stdin';
  scope?: LiveTurnScope;
  aliasJid?: string;
  commandId: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  createdByWorkerId?: string | null;
  now?: string;
}): Promise<LiveControlRouteResult> {
  let turn: LiveTurn | null = null;
  if (input.scope) {
    turn = await input.liveTurns.getActiveLiveTurn({ scope: input.scope });
  }
  if (!turn && input.aliasJid) {
    turn = await input.liveTurns.findActiveLiveTurnByStopAlias({
      aliasJid: input.aliasJid,
    });
  }
  if (!turn) return { outcome: 'no_active_turn' };
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
export async function routeLiveStop(input: {
  liveTurns: LiveTurnRoutingRepository;
  scope?: LiveTurnScope;
  aliasJid?: string;
  commandId: string;
  idempotencyKey: string;
  requestedBy?: string | null;
  createdByWorkerId?: string | null;
  now?: string;
}): Promise<LiveControlRouteResult> {
  return routeLiveControlCommand({
    ...input,
    commandType: 'stop',
    payload: input.requestedBy ? { requestedBy: input.requestedBy } : {},
  });
}

/** Route a close-stdin signal (end of input for the current turn). */
export async function routeLiveCloseStdin(input: {
  liveTurns: LiveTurnRoutingRepository;
  scope?: LiveTurnScope;
  aliasJid?: string;
  commandId: string;
  idempotencyKey: string;
  createdByWorkerId?: string | null;
  now?: string;
}): Promise<LiveControlRouteResult> {
  return routeLiveControlCommand({ ...input, commandType: 'close_stdin' });
}
