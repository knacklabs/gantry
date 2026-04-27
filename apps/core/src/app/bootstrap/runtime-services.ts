import { DEFAULT_TRIGGER } from '../../config/index.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../../shared/message-cursor.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { NewMessage } from '../../domain/types.js';
import {
  writeJobEventsSnapshot,
  writeJobRunsSnapshot,
  writeJobsSnapshot,
  writeGroupsSnapshot,
} from '../../runtime/agent-spawn.js';
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
import type { Job } from '../../domain/types.js';
import type { OpsRepository } from '../../domain/repositories/ops-repo.js';
import { getRuntimeOpsRepository } from '../../adapters/storage/postgres/runtime-store.js';
import { ChannelWiring } from './channel-wiring.js';
import { RuntimeApp } from './runtime-app.js';

interface RuntimeServicesDeps {
  startSchedulerLoop: typeof startSchedulerLoop;
  startIpcWatcher: typeof startIpcWatcher;
  writeJobsSnapshot: typeof writeJobsSnapshot;
  writeJobRunsSnapshot: typeof writeJobRunsSnapshot;
  writeJobEventsSnapshot: typeof writeJobEventsSnapshot;
  writeGroupsSnapshot: typeof writeGroupsSnapshot;
  opsRepository: OpsRepository;
  recoverPendingMessages: typeof recoverPendingMessages;
  startMessagePollingLoop: typeof startMessagePollingLoop;
  logger: Pick<typeof logger, 'info' | 'warn' | 'fatal'>;
  exit: (code: number) => never;
}

export interface RuntimeServicesOptions {
  app: RuntimeApp;
  channelWiring: ChannelWiring;
}

function makeDefaultDeps(
  injectedOpsRepository?: OpsRepository,
): RuntimeServicesDeps {
  return {
    startSchedulerLoop,
    startIpcWatcher,
    writeJobsSnapshot,
    writeJobRunsSnapshot,
    writeJobEventsSnapshot,
    writeGroupsSnapshot,
    opsRepository: injectedOpsRepository ?? getRuntimeOpsRepository(),
    recoverPendingMessages,
    startMessagePollingLoop,
    logger,
    exit: (code: number) => process.exit(code),
  };
}

function mapJobRowsForSnapshot(jobs: Job[]) {
  return jobs.map((job) => ({
    id: job.id,
    name: job.name,
    prompt: job.prompt,
    model: job.model || null,
    script: job.script || undefined,
    schedule_type: job.schedule_type,
    schedule_value: job.schedule_value,
    status: job.status,
    group_scope: job.group_scope,
    linked_sessions: job.linked_sessions,
    thread_id: job.thread_id,
    next_run: job.next_run,
    created_by: job.created_by,
    created_at: job.created_at,
    updated_at: job.updated_at,
    silent: job.silent,
    cleanup_after_ms: job.cleanup_after_ms,
    timeout_ms: job.timeout_ms,
    max_retries: job.max_retries,
    retry_backoff_ms: job.retry_backoff_ms,
    max_consecutive_failures: job.max_consecutive_failures,
    consecutive_failures: job.consecutive_failures,
    execution_mode: job.execution_mode,
    pause_reason: job.pause_reason,
  }));
}

function createSchedulerStateSync(
  app: RuntimeApp,
  deps: RuntimeServicesDeps,
): () => void {
  let syncInFlight: Promise<void> | undefined;
  let syncDirty = false;

  const runSync = async () => {
    do {
      syncDirty = false;
      const [jobs, runs, events] = await Promise.all([
        deps.opsRepository.getAllJobs(),
        deps.opsRepository.getRecentJobRuns(500),
        deps.opsRepository.listRecentJobEvents(1000),
      ]);
      const [registeredGroups, availableGroups] = [
        app.getRegisteredGroups(),
        await app.getAvailableGroups(),
      ];

      const jobRows = mapJobRowsForSnapshot(jobs);
      const registeredJids = new Set(Object.keys(registeredGroups));
      await Promise.all(
        Object.values(registeredGroups).flatMap((group) => {
          const isMain = group.isMain === true;
          return [
            deps.writeJobsSnapshot(group.folder, isMain, jobRows),
            deps.writeJobRunsSnapshot(group.folder, isMain, runs, jobRows),
            deps.writeJobEventsSnapshot(group.folder, isMain, events, jobRows),
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
        deps.logger.warn({ err }, 'Failed to write scheduler snapshots'),
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
  const syncSchedulerState = createSchedulerStateSync(app, resolved);

  const onSchedulerChanged = (jobId?: string) => {
    syncSchedulerState();
    requestSchedulerSync(jobId);
  };

  await resolved.startSchedulerLoop({
    registeredGroups: () => app.getRegisteredGroups(),
    queue: app.queue,
    onProcess: (groupJid, proc, containerName, groupFolder, stopAliasJids) =>
      app.queue.registerProcess(
        groupJid,
        proc,
        containerName,
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
  });

  resolved.startIpcWatcher({
    sendMessage: (jid, text, options) =>
      channelWiring.sendMessage(jid, text, {
        throwOnMissing: true,
        ...(options?.threadId
          ? { messageOptions: { threadId: options.threadId } }
          : {}),
      }),
    registeredGroups: () => app.getRegisteredGroups(),
    registerGroup: app.registerGroup,
    syncGroups: async (force: boolean) => {
      await channelWiring.syncGroups(force);
    },
    getAvailableGroups: app.getAvailableGroups,
    writeGroupsSnapshot: (
      groupFolder,
      isMain,
      availableGroups,
      registeredJids,
    ) =>
      resolved.writeGroupsSnapshot(
        groupFolder,
        isMain,
        availableGroups,
        registeredJids,
      ),
    onSchedulerChanged,
    opsRepository: resolved.opsRepository,
    requestPermissionApproval: channelWiring.requestPermissionApproval,
    requestUserAnswer: channelWiring.requestUserAnswer,
  });

  syncSchedulerState();

  app.queue.setProcessMessagesFn((chatJid) =>
    app.processGroupMessages(chatJid, { queued: true }),
  );

  const handleActiveControlCommand = async ({
    chatJid,
    queueJid,
    command,
    message,
  }: {
    chatJid: string;
    queueJid: string;
    command: { kind: string };
    message: NewMessage;
  }): Promise<boolean> => {
    if (command.kind !== 'stop' && command.kind !== 'new') {
      return false;
    }

    if (!app.queue.isGroupActive(queueJid)) {
      return false;
    }

    const threadId =
      typeof message.thread_id === 'string' && message.thread_id.trim()
        ? message.thread_id.trim()
        : undefined;

    if (command.kind === 'new') {
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
      getRegisteredGroups: () => app.getRegisteredGroups(),
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
      getRegisteredGroups: () => app.getRegisteredGroups(),
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
