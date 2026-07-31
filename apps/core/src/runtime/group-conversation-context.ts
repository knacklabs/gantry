import { logger } from '../infrastructure/logging/logger.js';
import { formatConversationContextMessages } from '../messaging/router.js';
import { buildMemoryRecallQueryFromMessages } from '../memory/app-memory-recall-query.js';
import type { NewMessage } from '../domain/types.js';
import type { ConversationId } from '../domain/conversation/conversation.js';
import type { ProviderAccountId } from '../domain/provider/provider.js';
import type {
  ConversationHistoryCoverageRepository,
  ConversationHistoryDistrustEpoch,
  ConversationHistoryScope,
} from '../domain/ports/conversation-history-coverage.js';
import type {
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
  GroupProcessingDeps,
  GroupProcessingRepository,
} from './group-processing-types.js';
import {
  buildConversationContextPacket,
  CONVERSATION_CONTEXT_LIMITS,
} from './conversation-context.js';

const CONVERSATION_CONTEXT_HYDRATION_TIMEOUT_MS = 2_500;

export async function buildGroupTurnConversationContext(input: {
  deps: GroupProcessingDeps;
  repository: GroupProcessingRepository;
  agentFolder: string;
  chatJid: string;
  conversationId?: string;
  providerAccountId?: string | null;
  activeThreadId: string | null | undefined;
  latestMessage: NewMessage;
  currentMessages: NewMessage[];
  timezone: string;
}) {
  let conversationContext = await buildConversationContextPacket({
    conversationJid: input.chatJid,
    providerAccountId: input.providerAccountId,
    activeThreadId: input.activeThreadId,
    latestMessage: input.latestMessage,
    currentMessages: input.currentMessages,
    repository: input.repository,
  });
  const shouldHydrate = shouldHydrateConversationContext(conversationContext);
  const coverageRepository =
    shouldHydrate && input.deps.channelRuntime.hydrateConversationContext
      ? input.deps.getConversationHistoryCoverageRepository?.()
      : undefined;
  const coverageScope = historyCoverageScope(input.activeThreadId);
  const coverageDistrustEpoch =
    coverageRepository && input.providerAccountId && input.conversationId
      ? readHistoryCoverageDistrustEpoch(
          input.deps.getHistoryCoverageDistrustEpoch,
          input.providerAccountId,
        )
      : undefined;
  const coverageRead = shouldHydrate
    ? await readHistoryCoverage({
        repository: coverageRepository,
        providerAccountId: input.providerAccountId,
        conversationId: input.conversationId,
        scope: coverageScope,
      })
    : undefined;
  const coverageDistrustEpochAfterRead = coverageDistrustEpoch
    ? readHistoryCoverageDistrustEpoch(
        input.deps.getHistoryCoverageDistrustEpoch,
        input.providerAccountId!,
      )
    : undefined;
  const coverageIsTrusted =
    coverageRead?.coverage?.complete === true &&
    coverageRead.isCurrentGeneration &&
    isHistoryCoverageDistrustEpochStable(
      coverageDistrustEpoch,
      coverageDistrustEpochAfterRead,
    );
  const hydration =
    shouldHydrate && !coverageIsTrusted
      ? await hydrateConversationContextWithDeadline({
          hydrate: input.deps.channelRuntime.hydrateConversationContext,
          request: {
            conversationJid: input.chatJid,
            ...(input.providerAccountId
              ? { providerAccountId: input.providerAccountId }
              : {}),
            threadId: input.activeThreadId,
            latestMessage: input.latestMessage,
            limits: CONVERSATION_CONTEXT_LIMITS,
          },
          providerId: input.latestMessage.provider,
        })
      : undefined;
  const rawHydratedMessages = stampProviderAccountOnHydratedMessages({
    providerAccountId: input.providerAccountId,
    messages: hydration?.messages ?? [],
  });
  const hydratedMessages = filterHydratedMessagesForPersistence({
    chatJid: input.chatJid,
    agentFolder: input.agentFolder,
    messages: rawHydratedMessages,
  });
  const droppedHydratedMessages =
    rawHydratedMessages.length - hydratedMessages.length;
  if (droppedHydratedMessages > 0) {
    logger.debug(
      {
        chatJid: input.chatJid,
        providerId: hydration?.providerId,
        messageCount: rawHydratedMessages.length,
        droppedCount: droppedHydratedMessages,
      },
      'Conversation context hydration dropped messages before persistence',
    );
  }
  let storedHydratedMessageCount = 0;
  let failedHydratedMessageCount = 0;
  for (const message of hydratedMessages) {
    try {
      await input.repository.storeMessage(message);
      storedHydratedMessageCount += 1;
    } catch (err) {
      failedHydratedMessageCount += 1;
      logger.warn(
        {
          storeError: hydrationErrorDiagnostics(err),
          providerId: hydration?.providerId,
          chatJid: input.chatJid,
          threadId: input.activeThreadId,
          messageId: message.id,
          externalMessageId: message.external_message_id,
          messageThreadId: message.thread_id,
          isFromMe: message.is_from_me,
          isBotMessage: message.is_bot_message,
        },
        'Conversation context hydration message persistence failed',
      );
    }
  }
  await attestHistoryCoverage({
    repository: coverageRepository,
    providerAccountId: input.providerAccountId,
    conversationId: input.conversationId,
    scope: coverageScope,
    hydration,
    currentProviderGeneration: coverageRead?.currentProviderGeneration,
    persistenceFailed: failedHydratedMessageCount > 0,
    capturedDistrustEpoch: coverageDistrustEpoch,
    getDistrustEpoch: input.deps.getHistoryCoverageDistrustEpoch,
  });
  if (hydratedMessages.length > 0) {
    conversationContext = await buildConversationContextPacket({
      conversationJid: input.chatJid,
      providerAccountId: input.providerAccountId,
      activeThreadId: input.activeThreadId,
      latestMessage: input.latestMessage,
      currentMessages: input.currentMessages,
      repository: input.repository,
    });
  }
  return {
    prompt: formatConversationContextMessages(
      conversationContext,
      input.timezone,
    ),
    recallQuery: buildMemoryRecallQueryFromMessages([
      ...conversationContext.recentChannelContext,
      ...conversationContext.activeThreadContext,
      ...conversationContext.currentMessages,
    ]),
    logContext: {
      context: conversationContext.metadata,
      hydration: hydration
        ? {
            providerId: hydration.providerId,
            attempted: hydration.attempted,
            skipped: hydration.skipped === true,
            failed: hydration.failed === true,
            messageCount: rawHydratedMessages.length,
            storeAttemptedMessageCount: hydratedMessages.length,
            storedMessageCount: storedHydratedMessageCount,
            storeFailedMessageCount: failedHydratedMessageCount,
            droppedMessageCount: droppedHydratedMessages,
          }
        : undefined,
    },
  };
}

async function readHistoryCoverage(input: {
  repository: ConversationHistoryCoverageRepository | undefined;
  providerAccountId?: string | null;
  conversationId?: string;
  scope: ConversationHistoryScope;
}) {
  if (!input.repository || !input.providerAccountId || !input.conversationId) {
    return undefined;
  }
  try {
    return await input.repository.getCoverage({
      providerAccountId: input.providerAccountId as ProviderAccountId,
      conversationId: input.conversationId as ConversationId,
      scope: input.scope,
    });
  } catch (err) {
    logger.warn(
      { coverageError: hydrationErrorDiagnostics(err) },
      'Conversation history coverage read failed',
    );
    return undefined;
  }
}

async function attestHistoryCoverage(input: {
  repository: ConversationHistoryCoverageRepository | undefined;
  providerAccountId?: string | null;
  conversationId?: string;
  scope: ConversationHistoryScope;
  hydration: ConversationContextHydrationResult | undefined;
  currentProviderGeneration: number | undefined;
  persistenceFailed: boolean;
  capturedDistrustEpoch: ConversationHistoryDistrustEpoch | undefined;
  getDistrustEpoch: GroupProcessingDeps['getHistoryCoverageDistrustEpoch'];
}): Promise<void> {
  const claim = input.hydration?.coverage;
  if (
    !input.repository ||
    !input.providerAccountId ||
    !input.conversationId ||
    !claim ||
    input.currentProviderGeneration === undefined
  ) {
    return;
  }
  const claimAllowsComplete =
    !input.persistenceFailed &&
    claim.scope === input.scope.kind &&
    claim.completeness.kind === 'server_confirmed' &&
    claim.completeness.exhausted;
  const distrustEpochAtWrite = claimAllowsComplete
    ? readHistoryCoverageDistrustEpoch(
        input.getDistrustEpoch,
        input.providerAccountId,
      )
    : undefined;
  const now = new Date().toISOString();
  try {
    await input.repository.upsertCoverage({
      providerAccountId: input.providerAccountId as ProviderAccountId,
      conversationId: input.conversationId as ConversationId,
      scope: input.scope,
      complete:
        claimAllowsComplete &&
        isHistoryCoverageDistrustEpochStable(
          input.capturedDistrustEpoch,
          distrustEpochAtWrite,
        ),
      ...(claim.requestedLatestMessage.externalMessageId !== undefined
        ? {
            coveredThroughExternalId:
              claim.requestedLatestMessage.externalMessageId,
          }
        : {}),
      coveredThroughTimestamp: claim.requestedLatestMessage.timestamp,
      providerGeneration: input.currentProviderGeneration,
      recordedAt: now,
      updatedAt: now,
    });
  } catch (err) {
    logger.warn(
      { coverageError: hydrationErrorDiagnostics(err) },
      'Conversation history coverage attestation failed',
    );
  }
}

function readHistoryCoverageDistrustEpoch(
  reader: GroupProcessingDeps['getHistoryCoverageDistrustEpoch'],
  providerAccountId: string,
): ConversationHistoryDistrustEpoch | undefined {
  return typeof reader === 'function' ? reader(providerAccountId) : undefined;
}

function isHistoryCoverageDistrustEpochStable(
  captured: ConversationHistoryDistrustEpoch | undefined,
  current: ConversationHistoryDistrustEpoch | undefined,
): boolean {
  return (
    captured !== undefined &&
    current !== undefined &&
    captured.current === captured.durable &&
    current.current === current.durable &&
    captured.current === current.current &&
    captured.durable === current.durable
  );
}

function historyCoverageScope(
  activeThreadId: string | null | undefined,
): ConversationHistoryScope {
  return activeThreadId
    ? { kind: 'thread', id: activeThreadId }
    : { kind: 'channel' };
}

async function hydrateConversationContextWithDeadline(input: {
  hydrate: GroupProcessingDeps['channelRuntime']['hydrateConversationContext'];
  request: ConversationContextHydrationRequest;
  providerId: string | undefined;
}): Promise<ConversationContextHydrationResult | undefined> {
  const hydrate = input.hydrate;
  if (!hydrate) return undefined;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const hydration = Promise.resolve()
    .then(() => hydrate(input.request))
    .catch((err) => {
      if (!timedOut) {
        logger.warn(
          {
            hydrationError: hydrationErrorDiagnostics(err),
            providerId: input.providerId,
            chatJid: input.request.conversationJid,
            threadId: input.request.threadId,
          },
          'Conversation context hydration failed',
        );
      }
      return undefined;
    });
  const deadline = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      logger.warn(
        {
          providerId: input.providerId,
          chatJid: input.request.conversationJid,
          threadId: input.request.threadId,
          timeoutMs: CONVERSATION_CONTEXT_HYDRATION_TIMEOUT_MS,
        },
        'Conversation context hydration timed out',
      );
      resolve(undefined);
    }, CONVERSATION_CONTEXT_HYDRATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([hydration, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function shouldHydrateConversationContext(
  context: Awaited<ReturnType<typeof buildConversationContextPacket>>,
) {
  if (context.metadata.activeThreadId) {
    return (
      !context.metadata.activeThreadWindowComplete ||
      !context.metadata.activeThreadRootPresent
    );
  }
  return !context.metadata.recentChannelWindowComplete;
}

function stampProviderAccountOnHydratedMessages(input: {
  providerAccountId?: string | null;
  messages: NewMessage[];
}): NewMessage[] {
  if (!input.providerAccountId || input.messages.length === 0) {
    return input.messages;
  }
  return input.messages.map((message) => ({
    ...message,
    providerAccountId: input.providerAccountId || undefined,
  }));
}

function filterHydratedMessagesForPersistence(input: {
  chatJid: string;
  agentFolder: string;
  messages: NewMessage[];
}): NewMessage[] {
  if (input.messages.length === 0) return input.messages;
  return input.messages.filter(
    (message) => message.is_from_me !== true && message.is_bot_message !== true,
  );
}

function hydrationErrorDiagnostics(err: unknown): {
  errorName?: string;
  errorCode?: string;
  errorConstraint?: string;
} {
  if (!err || typeof err !== 'object') return {};
  const record = err as {
    name?: unknown;
    code?: unknown;
    constraint?: unknown;
  };
  return {
    ...(typeof record.name === 'string' ? { errorName: record.name } : {}),
    ...(typeof record.code === 'string' ? { errorCode: record.code } : {}),
    ...(typeof record.constraint === 'string'
      ? { errorConstraint: record.constraint }
      : {}),
  };
}
