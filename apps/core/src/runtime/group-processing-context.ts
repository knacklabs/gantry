import { logger } from '../infrastructure/logging/logger.js';
import type { NewMessage } from '../domain/types.js';
import type {
  GroupProcessingDeps,
  GroupProcessingRepository,
} from './group-processing-types.js';
import { buildGroupTurnConversationContext } from './group-conversation-context.js';

export async function buildGroupProcessingConversationContext(input: {
  deps: GroupProcessingDeps;
  repository: GroupProcessingRepository;
  groupName: string;
  agentFolder: string;
  chatJid: string;
  providerAccountId?: string | null;
  activeThreadId: string | null | undefined;
  latestMessage: NewMessage;
  currentMessages: NewMessage[];
  timezone: string;
}) {
  const { prompt, recallQuery, logContext } =
    await buildGroupTurnConversationContext({
      deps: input.deps,
      repository: input.repository,
      agentFolder: input.agentFolder,
      chatJid: input.chatJid,
      providerAccountId: input.providerAccountId,
      activeThreadId: input.activeThreadId,
      latestMessage: input.latestMessage,
      currentMessages: input.currentMessages,
      timezone: input.timezone,
    });
  logger.info(
    {
      group: input.groupName,
      messageCount: input.currentMessages.length,
      ...logContext,
    },
    'Processing messages with conversation context',
  );
  return { prompt, recallQuery };
}
