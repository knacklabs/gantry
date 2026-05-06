import { DEFAULT_TRIGGER } from '../../config/index.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../../shared/message-cursor.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { NewMessage } from '../../domain/types.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import { writeGroupsSnapshot } from '../../runtime/agent-spawn.js';
import { startIpcWatcher } from '../../runtime/ipc.js';
import {
  recoverPendingMessages,
  startMessagePollingLoop,
} from '../../runtime/message-loop.js';
import {
  requestSchedulerSync,
  startSchedulerLoop,
} from '../../jobs/scheduler.js';
import { makeThreadQueueKey } from '../../runtime/thread-queue-key.js';
import type {
  RuntimeAgentSessionRepository,
  RuntimeChatMetadataRepository,
  RuntimeConversationRouteRepository,
  RuntimeJobRepository,
  RuntimeMessageRepository,
  RuntimeRouterStateRepository,
} from '../../domain/repositories/ops-repo.js';
import {
  getRuntimeRepositories,
  getRuntimeStorage,
} from '../../adapters/storage/postgres/runtime-store.js';
import type { SessionMemoryCollector } from '../../domain/ports/session-memory-collector.js';
import { ChannelWiring } from './channel-wiring.js';
import { RuntimeApp } from './runtime-app.js';
import { collectDurableMemoryAtSessionBoundary } from '../../memory/app-memory-service.js';

type RuntimeBootstrapRepository = RuntimeChatMetadataRepository &
  RuntimeMessageRepository &
  RuntimeJobRepository &
  RuntimeRouterStateRepository &
  RuntimeAgentSessionRepository &
  RuntimeConversationRouteRepository;

interface RuntimeServicesDeps {
  startSchedulerLoop: typeof startSchedulerLoop;
  startIpcWatcher: typeof startIpcWatcher;
  writeGroupsSnapshot: typeof writeGroupsSnapshot;
  opsRepository: RuntimeBootstrapRepository;
  recoverPendingMessages: typeof recoverPendingMessages;
  startMessagePollingLoop: typeof startMessagePollingLoop;
  logger: Pick<typeof logger, 'info' | 'warn' | 'fatal'>;
  mcpHostnameLookup?: HostnameLookup;
  collectSessionMemory: SessionMemoryCollector;
  exit: (code: number) => never;
}

export interface RuntimeServicesOptions {
  app: RuntimeApp;
  channelWiring: ChannelWiring;
}

function makeDefaultDeps(
  injectedRuntimeRepository?: RuntimeBootstrapRepository,
): RuntimeServicesDeps {
  return {
    startSchedulerLoop,
    startIpcWatcher,
    writeGroupsSnapshot,
    opsRepository: injectedRuntimeRepository ?? getRuntimeRepositories(),
    recoverPendingMessages,
    startMessagePollingLoop,
    logger,
    collectSessionMemory: collectDurableMemoryAtSessionBoundary,
    exit: (code: number) => process.exit(code),
  };
}

function createGroupSnapshotSync(
  app: RuntimeApp,
  deps: RuntimeServicesDeps,
): () => void {
  let syncInFlight: Promise<void> | undefined;
  let syncDirty = false;

  const runSync = async () => {
    do {
      syncDirty = false;
      const [conversationRoutes, availableGroups] = [
        app.getConversationRoutes(),
        await app.getAvailableGroups(),
      ];

      const registeredJids = new Set(Object.keys(conversationRoutes));
      await Promise.all(
        Object.values(conversationRoutes).flatMap((group) => {
          const isMain = group.isMain === true;
          return [
            deps.writeGroupsSnapshot(
              group.folder,
              isMain,
              availableGroups,
              registeredJids,
            ),
          ];
        }),
      );
    } while (syncDirty);
  };

  return () => {
    if (syncInFlight) {
      syncDirty = true;
      return;
    }
    syncInFlight = runSync()
      .catch((err) =>
        deps.logger.warn({ err }, 'Failed to write group snapshots'),
      )
      .finally(() => {
        syncInFlight = undefined;
      });
  };
}

export async function startRuntimeServices(
  options: RuntimeServicesOptions,
  deps: Partial<RuntimeServicesDeps> = {},
): Promise<void> {
  const resolved: RuntimeServicesDeps = {
    ...makeDefaultDeps(deps.opsRepository),
    ...deps,
  };

  const { app, channelWiring } = options;
  const syncGroupSnapshots = createGroupSnapshotSync(app, resolved);

  const onSchedulerChanged = (jobId?: string) => {
    requestSchedulerSync(jobId);
  };

  await resolved.startSchedulerLoop({
    conversationRoutes: () => app.getConversationRoutes(),
    queue: app.queue,
    onProcess: (groupJid, proc, runHandle, groupFolder, stopAliasJids) =>
      app.queue.registerProcess(
        groupJid,
        proc,
        runHandle,
        groupFolder,
        stopAliasJids,
      ),
    sendMessage: (jid, rawText, options) =>
      channelWiring.sendMessage(jid, rawText, {
        ...(options?.threadId
          ? { messageOptions: { threadId: options.threadId } }
          : {}),
      }),
    sendStreamingChunk: (jid, rawText, chunkOptions) =>
      channelWiring.sendStreamingChunk(jid, rawText, chunkOptions),
    resetStreaming: (jid) => {
      channelWiring.resetStreaming(jid);
    },
    onSchedulerChanged,
    opsRepository: resolved.opsRepository,
    collectSessionMemory: resolved.collectSessionMemory,
    getToolRepository: () => getRuntimeStorage().repositories.tools,
  });

  resolved.startIpcWatcher({
    sendMessage: (jid, text, options) =>
      channelWiring.sendMessage(jid, text, {
        throwOnMissing: true,
        ...(options?.threadId
          ? { messageOptions: { threadId: options.threadId } }
          : {}),
      }),
    conversationRoutes: () => app.getConversationRoutes(),
    registerGroup: app.registerGroup,
    syncGroups: async (force: boolean) => {
      await channelWiring.syncGroups(force);
    },
    getAvailableGroups: app.getAvailableGroups,
    writeGroupsSnapshot: (folder, isMain, availableGroups, registeredJids) =>
      resolved.writeGroupsSnapshot(
        folder,
        isMain,
        availableGroups,
        registeredJids,
      ),
    onSchedulerChanged,
    opsRepository: resolved.opsRepository,
    getToolRepository: () => getRuntimeStorage().repositories.tools,
    requestPermissionApproval: channelWiring.requestPermissionApproval,
    requestUserAnswer: channelWiring.requestUserAnswer,
    mcpHostnameLookup: resolved.mcpHostnameLookup,
  });

  syncGroupSnapshots();

  app.queue.setProcessMessagesFn((chatJid) =>
    app.processGroupMessages(chatJid, { queued: true }),
  );

  const handleActiveControlCommand = async ({
    chatJid,
    queueJid,
    group,
    command,
    message,
  }: {
    chatJid: string;
    queueJid: string;
    group: { folder: string; conversationKind?: 'dm' | 'channel' };
    command: { kind: string };
    message: NewMessage;
  }): Promise<boolean> => {
    if (
      command.kind !== 'stop' &&
      command.kind !== 'new' &&
      command.kind !== 'compact'
    ) {
      return false;
    }

    if (!app.queue.isGroupActive(queueJid)) {
      return false;
    }

    const threadId =
      typeof message.thread_id === 'string' && message.thread_id.trim()
        ? message.thread_id.trim()
        : undefined;

    if (command.kind === 'compact') {
      const sent = app.queue.sendMessage(queueJid, '/compact', { threadId });
      if (!sent) return false;
      app.setAgentCursor(
        makeThreadQueueKey(chatJid, threadId),
        encodeGroupMessageCursor(toGroupMessageCursor(message)),
      );
      await app.saveState();
      await channelWiring.sendMessage(
        chatJid,
        'Compacting current session.',
        threadId ? { messageOptions: { threadId } } : undefined,
      );
      return true;
    }

    if (command.kind === 'new') {
      try {
        const turnContext = await resolved.opsRepository.getAgentTurnContext?.({
          agentFolder: group.folder,
          conversationJid: chatJid,
          threadId,
        });
        if (turnContext?.agentSessionId) {
          await resolved.collectSessionMemory({
            agentSessionId: turnContext.agentSessionId,
            trigger: 'session-end',
            defaultScope: group.conversationKind === 'dm' ? 'user' : 'group',
          });
        }
      } catch (err) {
        resolved.logger.warn(
          { err, chatJid, threadId },
          'Failed to collect active session memory for /new; continuing with reset',
        );
      }
      try {
        await app.clearSessionForChatJid(chatJid, threadId);
      } catch (err) {
        resolved.logger.warn(
          { err, chatJid, threadId },
          'Failed to clear active session for /new',
        );
        await channelWiring.sendMessage(
          chatJid,
          'Could not start a fresh session because session state could not be persisted. The current run was left unchanged.',
          threadId ? { messageOptions: { threadId } } : undefined,
        );
        return true;
      }
    }

    const stopped = app.queue.stopGroup(queueJid);
    if (!stopped) {
      return false;
    }

    app.setAgentCursor(
      makeThreadQueueKey(chatJid, threadId),
      encodeGroupMessageCursor(toGroupMessageCursor(message)),
    );
    await app.saveState();

    await channelWiring.sendMessage(
      chatJid,
      command.kind === 'stop'
        ? 'Stopping current run.'
        : 'Started a fresh session.',
      threadId ? { messageOptions: { threadId } } : undefined,
    );

    return true;
  };

  void Promise.resolve(
    resolved.recoverPendingMessages({
      getConversationRoutes: () => app.getConversationRoutes(),
      getLastTimestamp: () => app.getLastTimestamp(),
      setLastTimestamp: (timestamp) => {
        app.setLastTimestamp(timestamp);
      },
      getOrRecoverCursor: app.getOrRecoverCursor,
      setAgentCursor: (chatJid, timestamp) => {
        app.setAgentCursor(chatJid, timestamp);
      },
      saveState: app.saveState,
      hasChannel: (chatJid) => channelWiring.hasChannel(chatJid),
      setTyping: (chatJid, isTyping) =>
        channelWiring.setTyping(chatJid, isTyping),
      sendProgressUpdate: (chatJid, text, options) =>
        channelWiring.sendProgressUpdate(chatJid, text, options),
      queue: app.queue,
      handleActiveControlCommand,
      opsRepository: resolved.opsRepository,
    }),
  ).catch((err) =>
    resolved.logger.warn({ err }, 'Pending message recovery failed'),
  );

  resolved.logger.info(`MyClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  resolved
    .startMessagePollingLoop({
      getConversationRoutes: () => app.getConversationRoutes(),
      getLastTimestamp: () => app.getLastTimestamp(),
      setLastTimestamp: (timestamp) => {
        app.setLastTimestamp(timestamp);
      },
      getOrRecoverCursor: app.getOrRecoverCursor,
      setAgentCursor: (chatJid, timestamp) => {
        app.setAgentCursor(chatJid, timestamp);
      },
      saveState: app.saveState,
      hasChannel: (chatJid) => channelWiring.hasChannel(chatJid),
      setTyping: (chatJid, isTyping) =>
        channelWiring.setTyping(chatJid, isTyping),
      sendProgressUpdate: (chatJid, text, options) =>
        channelWiring.sendProgressUpdate(chatJid, text, options),
      queue: app.queue,
      handleActiveControlCommand,
      opsRepository: resolved.opsRepository,
    })
    .catch((err) => {
      resolved.logger.fatal({ err }, 'Message loop crashed unexpectedly');
      resolved.exit(1);
    });
}
