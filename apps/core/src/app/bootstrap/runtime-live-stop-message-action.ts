import { makeThreadQueueKey } from '../../shared/thread-queue-key.js';
import type { ChannelWiring } from './channel-wiring-types.js';

export function registerRuntimeLiveStopMessageAction(
  channelWiring: ChannelWiring,
  app: { getConversationRoutes(): Record<string, { folder?: string }> },
  liveMessageQueue: {
    stopGroup: (queueJid: string) => boolean | Promise<boolean>;
  },
): void {
  registerLiveStopMessageAction({
    channelWiring,
    sourceAgentFolderFor: (jid) => app.getConversationRoutes()[jid]?.folder,
    stopGroup: liveMessageQueue.stopGroup,
  });
}

export function registerLiveStopMessageAction(input: {
  channelWiring: ChannelWiring;
  sourceAgentFolderFor: (conversationJid: string) => string | undefined;
  stopGroup: (queueJid: string) => boolean | Promise<boolean>;
}): void {
  input.channelWiring.setMessageActionHandler(async (action) => {
    if (action.kind !== 'live_turn_stop') return;
    const sourceAgentFolder = input.sourceAgentFolderFor(
      action.conversationJid,
    );
    if (!action.userId || !sourceAgentFolder) return;
    const allowed = await input.channelWiring.isControlApproverAllowed({
      conversationJid: action.conversationJid,
      userId: action.userId,
      sourceAgentFolder,
      decisionPolicy: 'same_channel',
    });
    if (!allowed) return;
    const queueJid = makeThreadQueueKey(
      action.conversationJid,
      action.threadId,
    );
    if (!(await input.stopGroup(action.actionToken || queueJid))) return;
    await input.channelWiring.sendMessage(
      action.conversationJid,
      'Stopping current run.',
      {
        durability: 'required',
        ...(action.threadId
          ? { messageOptions: { threadId: action.threadId } }
          : {}),
      },
    );
  });
}
