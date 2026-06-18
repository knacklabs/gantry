import type { NewMessage } from '../../domain/types.js';
import type {
  LiveTurnCommand,
  LiveTurnCommandRepository,
  LiveTurnLeaseFence,
} from '../../domain/ports/live-turns.js';
import { formatMessages } from '../../messaging/router.js';
import { buildPendingMessagesContinuationIdempotencyKey } from '../../runtime/pending-message-replay.js';
import { resolveNonSelfSenderIds } from '../../runtime/session-resume-runtime.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../../shared/message-cursor.js';

export function buildLiveTurnContinuation(input: {
  queueJid: string;
  sinceCursor?: string;
  messages: readonly NewMessage[] | undefined;
  timezone: string;
  onRouted?: () => Promise<void> | void;
  setAgentCursor?: (queueJid: string, cursor: string) => void;
  saveState?: () => Promise<void> | void;
}): {
  text: string;
  senderUserIds: readonly string[];
  idempotencyKey: string;
  cursorAfter: string;
  onRouted: () => Promise<void> | void;
} | null {
  if (!input.messages?.length) return null;
  const messages = [...input.messages];
  const lastMessage = messages[messages.length - 1];
  const cursorAfter = encodeGroupMessageCursor(
    toGroupMessageCursor(lastMessage),
  );
  return {
    text: formatMessages(messages, input.timezone),
    senderUserIds: resolveNonSelfSenderIds(messages),
    idempotencyKey: buildPendingMessagesContinuationIdempotencyKey({
      queueJid: input.queueJid,
      sinceCursor: input.sinceCursor ?? '',
      cursorAfter,
      messages,
    }),
    cursorAfter,
    onRouted:
      input.onRouted ??
      (async () => {
        input.setAgentCursor?.(input.queueJid, cursorAfter);
        await input.saveState?.();
      }),
  };
}

export function latestPendingContinuationCursor(
  commands: readonly LiveTurnCommand[],
): string | null {
  let latest: LiveTurnCommand | null = null;
  for (const command of commands) {
    if (command.commandType !== 'continuation') continue;
    if (!latest || command.seq > latest.seq) latest = command;
  }
  const cursorAfter = latest?.payload.cursorAfter;
  return typeof cursorAfter === 'string' ? cursorAfter : null;
}

export async function markPendingContinuationCommandsApplied(input: {
  liveTurns: Pick<LiveTurnCommandRepository, 'markLiveTurnCommandApplied'>;
  commands: readonly LiveTurnCommand[];
  fence: LiveTurnLeaseFence;
}): Promise<void> {
  await Promise.all(
    input.commands
      .filter((command) => command.commandType === 'continuation')
      .map((command) =>
        input.liveTurns.markLiveTurnCommandApplied({
          id: command.id,
          appliedByWorkerId: input.fence.workerInstanceId,
          fence: input.fence,
        }),
      ),
  );
}
