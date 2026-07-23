import { logger } from '../../infrastructure/logging/logger.js';
import type {
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../../domain/types.js';
import { TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS } from './channel-shared.js';

type InteractionIdentity = Pick<
  PermissionApprovalRequest,
  'appId' | 'sourceAgentFolder' | 'requestId'
>;
type PendingTelegramQuestion = {
  timer: ReturnType<typeof setTimeout>;
  callbackId: string;
  appId: string;
  sourceAgentFolder: string;
  requestId: string;
  multiSelect: boolean;
  optionLabels: string[];
  selectedOptionIndexes: Set<number>;
  resolve(value: { selected: string | string[]; answeredBy: 'system' }): void;
};
type TelegramQuestionTarget = Pick<
  PendingTelegramQuestion,
  'appId' | 'sourceAgentFolder' | 'requestId'
>;

export async function disconnectTelegramDelivery(input: {
  bot: { stop(): void } | null;
  activeDraftStreams: Map<unknown, { closeStream(): void }>;
  activeGroupStreams: Map<unknown, unknown>;
  streamGenerationByJid: Map<unknown, unknown>;
  sealedStreamGenerationByJid: Map<unknown, unknown>;
  activeProgressMessages: Map<unknown, unknown>;
  mediaIngestionQueue: { waitForIdle(timeoutMs: number): Promise<boolean> };
  pendingPermissionPrompts: Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      request: InteractionIdentity;
      resolve(value: {
        approved: false;
        mode: 'cancel';
        decidedBy: 'system';
        reason: 'Telegram channel disconnected';
      }): void;
    }
  >;
  settlePermissionPrompt(
    providerAlias: string,
  ): Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'>;
  pendingUserQuestionCallbackIds: Map<string, TelegramQuestionTarget>;
  pendingUserQuestions: Map<string, PendingTelegramQuestion>;
  releasePollingLease(): Promise<void>;
}): Promise<{ bot: null; draftStreamApi: null }> {
  for (const streamState of input.activeDraftStreams.values()) {
    streamState.closeStream();
  }
  input.activeDraftStreams.clear();
  input.activeGroupStreams.clear();
  input.streamGenerationByJid.clear();
  input.sealedStreamGenerationByJid.clear();
  input.activeProgressMessages.clear();
  const mediaDrained = await input.mediaIngestionQueue.waitForIdle(
    TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS,
  );
  if (!mediaDrained) {
    logger.warn(
      { timeoutMs: TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS },
      'Timed out waiting for Telegram media ingestion queue to drain',
    );
  }
  for (const providerAlias of input.pendingPermissionPrompts.keys()) {
    const result = await input.settlePermissionPrompt(providerAlias);
    if (result === 'already_decided') continue;
    const pending = input.pendingPermissionPrompts.get(providerAlias);
    if (!pending) continue;
    clearTimeout(pending.timer);
    input.pendingPermissionPrompts.delete(providerAlias);
    pending.resolve({
      approved: false,
      mode: 'cancel',
      decidedBy: 'system',
      reason: 'Telegram channel disconnected',
    });
  }
  for (const [key, pending] of input.pendingUserQuestions.entries()) {
    clearTimeout(pending.timer);
    pending.resolve({
      selected: pending.multiSelect
        ? [...pending.selectedOptionIndexes]
            .sort((a, b) => a - b)
            .map((index) => pending.optionLabels[index])
            .filter((label): label is string => Boolean(label))
        : '',
      answeredBy: 'system',
    });
    input.pendingUserQuestions.delete(key);
  }
  input.pendingUserQuestionCallbackIds.clear();
  if (input.bot) {
    input.bot.stop();
    await input.releasePollingLease();
    logger.info('Telegram bot stopped');
  }
  return { bot: null, draftStreamApi: null };
}

export function dropPendingTelegramInteraction(
  kind: 'permission' | 'question',
  request: InteractionIdentity | UserQuestionRequest,
  permissions: Map<
    string,
    { timer: ReturnType<typeof setTimeout>; request: InteractionIdentity }
  >,
  questions: Map<string, PendingTelegramQuestion>,
  callbacks: Map<string, TelegramQuestionTarget>,
  otherPrompts: Map<string, TelegramQuestionTarget>,
): void {
  const matches = (candidate: InteractionIdentity): boolean =>
    candidate.requestId === request.requestId &&
    candidate.sourceAgentFolder === request.sourceAgentFolder &&
    (candidate.appId || 'default') === (request.appId || 'default');
  if (kind === 'permission') {
    for (const [providerAlias, pending] of permissions) {
      if (!matches(pending.request)) continue;
      clearTimeout(pending.timer);
      permissions.delete(providerAlias);
    }
    return;
  }
  for (const [key, pending] of questions) {
    if (!matches(pending)) continue;
    clearTimeout(pending.timer);
    questions.delete(key);
    callbacks.delete(pending.callbackId);
  }
  for (const [callbackId, target] of callbacks) {
    if (matches(target)) callbacks.delete(callbackId);
  }
  for (const [promptId, target] of otherPrompts) {
    if (matches(target)) otherPrompts.delete(promptId);
  }
}
