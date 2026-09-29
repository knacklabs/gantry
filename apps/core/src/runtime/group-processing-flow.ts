import type { FinalProgressState } from './progress-updates.js';
import type { NewMessage, MessageSendOptions } from '../domain/types.js';
import type {
  LiveAdmissionInputScope,
  LiveAdmissionWorkItemRepository,
} from '../domain/ports/live-turns.js';
import type { RuntimeMessageRepository } from '../domain/repositories/ops-repo.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
import { extractSessionCommand } from '../session/session-commands.js';
import { resolveGroupReactionTarget } from './group-reaction-target.js';
import { createGroupTurnOptionBuilders } from './group-turn-options.js';
import { createGroupTurnTypingSender } from './group-liveness-state.js';
import { createProgressChannelSender } from './group-progress-channel-sender.js';
import { logger } from '../infrastructure/logging/logger.js';

type GroupTurnRunResult = 'success' | 'error' | 'stopped';

function providerSecond(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Math.floor(
    (Number.isNaN(parsed) ? Number(timestamp) * 1000 : parsed) / 1000,
  );
}

export function orderBatchForPresentation<
  T extends { message: NewMessage; receiveOrder: number | null },
>(batch: T[]): T[] {
  return [...batch].sort((left, right) => {
    const timeOrder =
      providerSecond(left.message.timestamp) -
      providerSecond(right.message.timestamp);
    if (Number.isFinite(timeOrder) && timeOrder !== 0) return timeOrder;
    return left.receiveOrder !== null && right.receiveOrder !== null
      ? left.receiveOrder - right.receiveOrder
      : 0;
  });
}

export async function takeGroupTurnInput(input: {
  repository: Pick<LiveAdmissionWorkItemRepository, 'takeInput'>;
  messages: Pick<RuntimeMessageRepository, 'getMessagesByIds'>;
  scope: LiveAdmissionInputScope;
  consumer: string;
  maxMessages: number;
  triggerPattern: RegExp;
  chatJid: string;
  threadId?: string | null;
}): Promise<{
  missedMessages: NewMessage[];
  hasMore: boolean;
  activeThreadId?: string;
  latestMessageReactionTarget?: { messageRef: string; threadId?: string };
}> {
  const takenMessages: Array<{
    message: NewMessage;
    receiveOrder: number | null;
  }> = [];
  for (let index = 0; index < input.maxMessages; index += 1) {
    const [item] = await input.repository.takeInput({
      scope: input.scope,
      limit: 1,
      consumedBy: input.consumer,
    });
    if (!item) break;
    const [message] = await input.messages.getMessagesByIds(input.scope, [
      item.messageId,
    ]);
    if (!message) throw new Error('Taken input has no scoped message row');
    takenMessages.push({ message, receiveOrder: item.receiveOrder });
    if (
      extractSessionCommand(message.content, input.triggerPattern) ||
      message.responseSchema !== undefined ||
      message.agentControls !== undefined
    )
      break;
  }
  const lastTaken = takenMessages[takenMessages.length - 1]?.message;
  const hasMore =
    takenMessages.length === input.maxMessages ||
    (lastTaken !== undefined &&
      (extractSessionCommand(lastTaken.content, input.triggerPattern) !==
        null ||
        lastTaken.responseSchema !== undefined ||
        lastTaken.agentControls !== undefined));
  const missedMessages = orderBatchForPresentation(takenMessages).map(
    ({ message }) => message,
  );
  const { activeThreadId, reactionTarget } = resolveGroupReactionTarget({
    chatJid: input.chatJid,
    routeThreadId: input.threadId ?? undefined,
    messages: missedMessages,
  });
  return {
    missedMessages,
    hasMore,
    activeThreadId,
    latestMessageReactionTarget: reactionTarget,
  };
}

export function createGroupTurnChannelActions(input: {
  channelRuntime: GroupProcessingDeps['channelRuntime'];
  chatJid: string;
  groupName: string;
  providerAccountId?: string;
  activeThreadId?: string;
  streamGeneration: () => number;
  progressGeneration: () => number;
}) {
  const turnOptions = createGroupTurnOptionBuilders(input);
  const setTurnTyping = createGroupTurnTypingSender(input);
  const sendMessageToChannel = async (
    text: string,
    options?: MessageSendOptions,
  ): Promise<void> =>
    void (await (options
      ? input.channelRuntime.sendMessage(input.chatJid, text, options)
      : input.channelRuntime.sendMessage(input.chatJid, text)));
  const finalizingProgressGenerations = new Set<number>();
  const sendProgressToChannel = createProgressChannelSender({
    channelRuntime: input.channelRuntime,
    chatJid: input.chatJid,
    groupName: input.groupName,
    providerAccountId: input.providerAccountId,
    threadId: input.activeThreadId,
    finalizingGenerations: finalizingProgressGenerations,
    log: logger,
  });
  return {
    turnOptions,
    setTurnTyping,
    sendMessageToChannel,
    sendProgressToChannel,
    finalizingProgressGenerations,
  };
}

export function createGroupTurnProgressSenders(input: {
  supportsProgress: boolean;
  sendProgressToChannel: ReturnType<typeof createProgressChannelSender>;
  buildProgressOptions: ReturnType<
    typeof createGroupTurnOptionBuilders
  >['buildProgressOptions'];
}) {
  return {
    sendControlOnlyProgress: async () => {
      if (!input.supportsProgress) return;
      await input
        .sendProgressToChannel('', {
          ...input.buildProgressOptions(),
          actionOnly: true,
        })
        .catch(() => undefined);
    },
    sendWaitingForUserResponseProgress: async () => {
      if (!input.supportsProgress) return;
      await input
        .sendProgressToChannel(
          'Waiting for your input.',
          input.buildProgressOptions({ replaceOnly: true }),
        )
        .catch(() => undefined);
    },
  };
}

export async function handleFailure(input: {
  outputSentToUser: boolean;
  acknowledgeFailedTurn?: boolean;
  preserveCursor?: boolean;
  groupName: string;
  queueJid: string;
  releaseInput: () => Promise<number>;
  deps: {
    setCursor: (chatJid: string, timestamp: string) => void;
    saveState: () => Promise<void> | void;
  };
  logger: {
    warn(payload: Record<string, unknown>, message: string): void;
  };
}): Promise<boolean> {
  if (input.outputSentToUser) {
    input.logger.warn(
      { group: input.groupName },
      'Agent error after output was sent, preserving consumed input to prevent duplicates',
    );
    return true;
  }
  if (input.acknowledgeFailedTurn) {
    await input.deps.saveState();
    input.logger.warn(
      { group: input.groupName },
      'Agent error on final retry, preserving consumed input to prevent stale replay',
    );
    return true;
  }
  if (input.preserveCursor) {
    await input.deps.saveState();
    input.logger.warn(
      { group: input.groupName },
      'Agent infrastructure error, preserving consumed input to prevent stale replay',
    );
    return true;
  }
  await input.releaseInput();
  input.logger.warn(
    { group: input.groupName },
    'Agent error, released input for retry',
  );
  return false;
}

export function resetGroupStreamingForTurn(input: {
  chatJid: string;
  groupName: string;
  channelRuntime: {
    resetStreaming(jid: string, options?: { providerAccountId?: string }): void;
  };
  providerAccountId?: string;
  logger: { debug(payload: Record<string, unknown>, message: string): void };
}): void {
  try {
    if (input.providerAccountId) {
      input.channelRuntime.resetStreaming(input.chatJid, {
        providerAccountId: input.providerAccountId,
      });
    } else {
      input.channelRuntime.resetStreaming(input.chatJid);
    }
  } catch (err) {
    input.logger.debug(
      { err, group: input.groupName },
      'Failed to reset channel streaming state before processing',
    );
  }
}

export async function waitOutput(input: {
  wait: () => Promise<void>;
  getError: () => unknown;
  hadError: boolean;
  groupName: string;
  logger: {
    error(payload: Record<string, unknown>, message: string): void;
  };
}): Promise<boolean> {
  await input.wait();
  const err = input.getError();
  if (!err) return input.hadError;
  input.logger.error(
    { group: input.groupName, err },
    'Agent output callback failed',
  );
  return true;
}

export function resolveGroupTurnFinalProgressState(input: {
  output: GroupTurnRunResult;
  hadError: boolean;
  sawDeliveryIncomplete: boolean;
  sawTerminalDeliveryFailure: boolean;
  outputSentToUser: boolean;
}): FinalProgressState {
  if (input.output === 'stopped') return 'stopped';
  if (input.output === 'error') return 'failed';
  if (input.hadError && !input.outputSentToUser) return 'failed';
  if (
    input.sawDeliveryIncomplete ||
    (input.sawTerminalDeliveryFailure && input.outputSentToUser)
  ) {
    return 'delivery_incomplete';
  }
  return input.sawTerminalDeliveryFailure ? 'failed' : 'completed';
}

export function shouldSendTurnFinalProgress(input: {
  finalProgressState: FinalProgressState;
  awaitingResponseReceipt: boolean;
  sentAnyTurnDoneProgress: boolean;
  activeGenerationHasOutput: boolean;
  sentTurnDoneProgressGeneration: number | null;
  progressGeneration: number;
}): boolean {
  return (
    !(
      input.finalProgressState === 'completed' && input.awaitingResponseReceipt
    ) &&
    (input.finalProgressState !== 'completed' ||
      !input.sentAnyTurnDoneProgress ||
      (input.activeGenerationHasOutput &&
        input.sentTurnDoneProgressGeneration !== input.progressGeneration))
  );
}
