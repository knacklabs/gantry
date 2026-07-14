import type { NewMessage } from '../../domain/types.js';
import type { RuntimeAgentSessionRepository } from '../../domain/repositories/ops-repo.js';
import type { SessionMemoryCollector } from '../../domain/ports/session-memory-collector.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../../shared/message-cursor.js';
import { resolveRuntimeExecutionProviderId } from '../../runtime/execution-provider-id.js';
import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import type { ChannelWiring } from './channel-wiring-types.js';

export function controlAckMessageOptions(
  threadId?: string,
  providerAccountId?: string,
): { threadId?: string; providerAccountId?: string } | undefined {
  return threadId || providerAccountId
    ? {
        ...(threadId ? { threadId } : {}),
        ...(providerAccountId ? { providerAccountId } : {}),
      }
    : undefined;
}

export async function handleActiveNewSessionCommand(input: {
  app: {
    queue: { stopGroup(queueKey: string): boolean };
    clearSessionForChatJid(
      chatJid: string,
      threadId?: string | null,
      metadata?: { memoryUserId?: string; providerAccountId?: string | null },
    ): Promise<void>;
    setAgentCursor(queueKey: string, cursor: string): void;
    saveState(): Promise<void>;
  };
  channelWiring: Pick<ChannelWiring, 'sendMessage'>;
  opsRepository: RuntimeAgentSessionRepository;
  collectSessionMemory: SessionMemoryCollector;
  logger: { warn(payload: unknown, message: string): void };
  group: {
    folder: string;
    conversationKind?: 'dm' | 'channel';
    providerAccountId?: string;
  };
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
  chatJid: string;
  queueJid: string;
  threadId?: string;
  message: NewMessage;
}): Promise<boolean> {
  const {
    app,
    channelWiring,
    opsRepository,
    collectSessionMemory,
    logger,
    group,
    chatJid,
    queueJid,
    threadId,
    message,
  } = input;
  let boundaryAgentSessionId: string | undefined;
  const defaultScope = group.conversationKind === 'dm' ? 'user' : 'group';
  const memoryUserId = message.sender?.trim() || undefined;
  const messageOptions = controlAckMessageOptions(
    threadId,
    group.providerAccountId,
  );
  try {
    const turnContext = await opsRepository.getAgentTurnContext?.({
      agentFolder: group.folder,
      executionProviderId: resolveRuntimeExecutionProviderId(
        input.executionAdapter,
      ),
      conversationJid: chatJid,
      providerAccountId: group.providerAccountId,
      threadId,
      conversationKind: group.conversationKind,
      memoryUserId,
      hydrateMemory: false,
    });
    boundaryAgentSessionId = turnContext?.agentSessionId;
  } catch (err) {
    logger.warn(
      { err, chatJid, threadId },
      'Failed to capture active session boundary for /new; continuing with reset',
    );
  }
  if (!app.queue.stopGroup(queueJid)) return false;
  try {
    await app.clearSessionForChatJid(queueJid, threadId, {
      memoryUserId,
      providerAccountId: group.providerAccountId,
    });
  } catch (err) {
    logger.warn(
      { err, chatJid, threadId },
      'Failed to clear active session for /new',
    );
    await channelWiring.sendMessage(
      chatJid,
      'Could not start a fresh session because session state could not be persisted. The active run was stopped; existing session state was left unchanged.',
      {
        durability: 'required',
        ...(messageOptions ? { messageOptions } : {}),
      },
    );
    return true;
  }
  if (boundaryAgentSessionId) {
    void collectSessionMemory({
      agentSessionId: boundaryAgentSessionId,
      trigger: 'session-end',
      defaultScope,
    }).catch((err) => {
      logger.warn(
        { err, chatJid, threadId, agentSessionId: boundaryAgentSessionId },
        'Failed to finalize active session memory after /new',
      );
    });
  }
  app.setAgentCursor(
    queueJid,
    encodeGroupMessageCursor(toGroupMessageCursor(message)),
  );
  await app.saveState();
  await channelWiring.sendMessage(chatJid, 'Started a fresh session.', {
    durability: 'required',
    ...(messageOptions ? { messageOptions } : {}),
  });
  return true;
}
