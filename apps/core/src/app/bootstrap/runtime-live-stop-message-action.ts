import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { processTaskIpc } from '../../runtime/ipc.js';
import {
  createIpcAuthEnvelope,
  revokeIpcResponseSigningKey,
} from '../../runtime/ipc-auth.js';
import { taskIpcResponsePath } from '../../jobs/ipc-shared.js';
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
  const taskId = `scheduler-run-now-${randomUUID()}`;
  const ipcAuth = createIpcAuthEnvelope(
    input.sourceAgentFolder,
    input.authThreadId,
  );
  const responsePath = taskIpcResponsePath(input.sourceAgentFolder, taskId);
  try {
    await processTaskIpc(
      {
        type: 'scheduler_run_now',
        taskId,
        jobId: input.jobId,
        chatJid: input.originConversationJid,
        targetJid: input.originConversationJid,
        authThreadId: input.authThreadId,
        responseKeyId: ipcAuth.responseKeyId,
      },
      input.sourceAgentFolder,
      {
        sendMessage: (
          jid: string,
          text: string,
          options?: MessageSendOptions,
        ) =>
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
    const result = await readSchedulerRunNowIpcResult(responsePath);
    if (!result) return `Scheduler retry result unavailable (${input.jobId}).`;
    if (!result.ok) {
      return result.error || `Scheduler retry failed (${input.jobId}).`;
    }
    return result.message || `Scheduler job queued (${input.jobId}).`;
  } finally {
    await fs.unlink(responsePath).catch(() => undefined);
    revokeIpcResponseSigningKey(
      ipcAuth.responseKeyId,
      input.sourceAgentFolder,
      input.authThreadId,
    );
  }
}

async function readSchedulerRunNowIpcResult(
  responsePath: string,
): Promise<{ ok: boolean; message?: string; error?: string } | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(responsePath, 'utf8')) as {
      ok?: unknown;
      message?: unknown;
      error?: unknown;
    };
    if (typeof parsed.ok !== 'boolean') return null;
    return {
      ok: parsed.ok,
      ...(typeof parsed.message === 'string'
        ? { message: parsed.message }
        : {}),
      ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
    };
  } catch {
    return null;
  }
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
    const stopped = action.actionToken
      ? await input.stopGroup(action.actionToken)
      : await input.stopGroup(queueJid);
    if (!stopped) return;
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
