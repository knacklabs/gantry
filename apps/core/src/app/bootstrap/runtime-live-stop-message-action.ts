import { processTaskIpc } from '../../runtime/ipc.js';
import type { IpcDeps } from '../../runtime/ipc-domain-types.js';
import { requestSchedulerSync } from '../../jobs/scheduler.js';
import { makeThreadQueueKey } from '../../shared/thread-queue-key.js';
import type { ChannelWiring } from './channel-wiring-types.js';
import type {
  ConversationRoute,
  MessageSendOptions,
} from '../../domain/types.js';

export function registerRuntimeLiveStopMessageAction(
  channelWiring: ChannelWiring,
  app: { getConversationRoutes(): Record<string, ConversationRoute> },
  liveMessageQueue: {
    stopGroup: (queueJid: string) => boolean | Promise<boolean>;
  },
  scheduler?: {
    runNow: (input: {
      jobId: string;
      sourceAgentFolder: string;
      originConversationJid: string;
      authThreadId?: string;
      conversationBindings: Record<string, ConversationRoute>;
      sourceConversationJids: string[];
    }) => Promise<string>;
  },
): void {
  registerLiveStopMessageAction({
    channelWiring,
    sourceAgentFolderFor: (jid) => app.getConversationRoutes()[jid]?.folder,
    conversationBindings: () => app.getConversationRoutes(),
    stopGroup: liveMessageQueue.stopGroup,
    runSchedulerNow:
      scheduler?.runNow ??
      ((input) => runSchedulerNowThroughIpc(input, channelWiring)),
  });
}

async function runSchedulerNowThroughIpc(
  input: {
    jobId: string;
    sourceAgentFolder: string;
    originConversationJid: string;
    authThreadId?: string;
    conversationBindings: Record<string, ConversationRoute>;
  },
  channelWiring: ChannelWiring,
): Promise<string> {
  await processTaskIpc(
    {
      type: 'scheduler_run_now',
      jobId: input.jobId,
      chatJid: input.originConversationJid,
      targetJid: input.originConversationJid,
      authThreadId: input.authThreadId,
    },
    input.sourceAgentFolder,
    {
      sendMessage: (jid: string, text: string, options?: MessageSendOptions) =>
        channelWiring.sendMessage(jid, text, {
          durability: 'required',
          ...(options ? { messageOptions: options } : {}),
        }),
      conversationRoutes: () => input.conversationBindings,
      registerGroup: () => {},
      syncGroups: () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onSchedulerChanged: requestSchedulerSync,
      requestPermissionApproval: async () => {
        throw new Error('Permission callbacks are unavailable here.');
      },
      requestUserAnswer: async () => {
        throw new Error('Question callbacks are unavailable here.');
      },
    } as unknown as IpcDeps,
  );
  return `Scheduler retry requested (${input.jobId}).`;
}

export function registerLiveStopMessageAction(input: {
  channelWiring: ChannelWiring;
  sourceAgentFolderFor: (conversationJid: string) => string | undefined;
  conversationBindings?: () => Record<string, ConversationRoute>;
  stopGroup: (queueJid: string) => boolean | Promise<boolean>;
  runSchedulerNow?: (schedulerInput: {
    jobId: string;
    sourceAgentFolder: string;
    originConversationJid: string;
    authThreadId?: string;
    conversationBindings: Record<string, ConversationRoute>;
    sourceConversationJids: string[];
  }) => Promise<string>;
}): void {
  input.channelWiring.setMessageActionHandler(async (action) => {
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
    if (action.kind === 'scheduler_run_now') {
      if (!input.runSchedulerNow || !input.conversationBindings) return;
      const conversationBindings = input.conversationBindings();
      const sourceConversationJids = Object.entries(conversationBindings)
        .filter(([, route]) => route.folder === sourceAgentFolder)
        .map(([jid]) => jid);
      const text = await input.runSchedulerNow({
        jobId: action.jobId,
        sourceAgentFolder,
        originConversationJid: action.conversationJid,
        authThreadId: action.threadId,
        conversationBindings,
        sourceConversationJids,
      });
      await input.channelWiring.sendMessage(action.conversationJid, text, {
        durability: 'required',
        ...(action.threadId
          ? { messageOptions: { threadId: action.threadId } }
          : {}),
      });
      return;
    }
    if (action.kind !== 'live_turn_stop') return;
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
