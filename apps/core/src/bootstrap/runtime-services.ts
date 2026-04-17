import { ASSISTANT_NAME, DEFAULT_TRIGGER } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  writeJobEventsSnapshot,
  writeJobRunsSnapshot,
  writeJobsSnapshot,
  writeGroupsSnapshot,
} from '../runtime/agent-spawn.js';
import { startIpcWatcher } from '../runtime/ipc.js';
import {
  recoverPendingMessages,
  startMessagePollingLoop,
} from '../runtime/message-loop.js';
import { writeSchedulerStateFileSafe } from '../runtime/scheduler-state-file.js';
import { startSchedulerLoop } from '../runtime/task-scheduler.js';
import { startSessionCleanup } from '../session/session-cleanup.js';
import {
  getAllJobs,
  getRecentJobRuns,
  listRecentJobEvents,
} from '../storage/db.js';
import { ChannelWiring } from './channel-wiring.js';
import { RuntimeApp } from './runtime-app.js';

interface RuntimeServicesDeps {
  startSchedulerLoop: typeof startSchedulerLoop;
  startIpcWatcher: typeof startIpcWatcher;
  writeSchedulerStateFileSafe: typeof writeSchedulerStateFileSafe;
  writeJobsSnapshot: typeof writeJobsSnapshot;
  writeJobRunsSnapshot: typeof writeJobRunsSnapshot;
  writeJobEventsSnapshot: typeof writeJobEventsSnapshot;
  writeGroupsSnapshot: typeof writeGroupsSnapshot;
  getAllJobs: typeof getAllJobs;
  getRecentJobRuns: typeof getRecentJobRuns;
  listRecentJobEvents: typeof listRecentJobEvents;
  recoverPendingMessages: typeof recoverPendingMessages;
  startMessagePollingLoop: typeof startMessagePollingLoop;
  startSessionCleanup: typeof startSessionCleanup;
  logger: Pick<typeof logger, 'info' | 'warn' | 'fatal'>;
  exit: (code: number) => never;
}

export interface RuntimeServicesOptions {
  app: RuntimeApp;
  channelWiring: ChannelWiring;
}

function makeDefaultDeps(): RuntimeServicesDeps {
  return {
    startSchedulerLoop,
    startIpcWatcher,
    writeSchedulerStateFileSafe,
    writeJobsSnapshot,
    writeJobRunsSnapshot,
    writeJobEventsSnapshot,
    writeGroupsSnapshot,
    getAllJobs,
    getRecentJobRuns,
    listRecentJobEvents,
    recoverPendingMessages,
    startMessagePollingLoop,
    startSessionCleanup,
    logger,
    exit: (code: number) => process.exit(code),
  };
}

function mapJobRowsForSnapshot(jobs: ReturnType<typeof getAllJobs>) {
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
  return () => {
    const jobs = deps.getAllJobs();
    const runs = deps.getRecentJobRuns(500);
    const events = deps.listRecentJobEvents(1000);

    deps.writeSchedulerStateFileSafe(jobs, runs, events);

    const jobRows = mapJobRowsForSnapshot(jobs);
    for (const group of Object.values(app.getRegisteredGroups())) {
      const isMain = group.isMain === true;
      deps.writeJobsSnapshot(group.folder, isMain, jobRows);
      deps.writeJobRunsSnapshot(group.folder, isMain, runs, jobRows);
      deps.writeJobEventsSnapshot(group.folder, isMain, events, jobRows);
    }
  };
}

export function startRuntimeServices(
  options: RuntimeServicesOptions,
  deps: Partial<RuntimeServicesDeps> = {},
): void {
  const resolved: RuntimeServicesDeps = {
    ...makeDefaultDeps(),
    ...deps,
  };

  const { app, channelWiring } = options;
  const syncSchedulerState = createSchedulerStateSync(app, resolved);

  resolved.startSchedulerLoop({
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
    sendMessage: (jid, rawText) => channelWiring.sendMessage(jid, rawText),
    sendStreamingChunk: (jid, rawText, chunkOptions) =>
      channelWiring.sendStreamingChunk(jid, rawText, chunkOptions),
    resetStreaming: (jid) => {
      channelWiring.resetStreaming(jid);
    },
    onSchedulerChanged: syncSchedulerState,
  });

  resolved.startIpcWatcher({
    sendMessage: (jid, text) =>
      channelWiring.sendMessage(jid, text, { throwOnMissing: true }),
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
    onSchedulerChanged: syncSchedulerState,
    requestPermissionApproval: channelWiring.requestPermissionApproval,
    requestUserAnswer: channelWiring.requestUserAnswer,
  });

  syncSchedulerState();
  resolved.startSessionCleanup();

  app.queue.setProcessMessagesFn((chatJid) =>
    app.processGroupMessages(chatJid),
  );

  resolved.recoverPendingMessages({
    assistantName: ASSISTANT_NAME,
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
  });

  resolved.logger.info(`MyClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  resolved
    .startMessagePollingLoop({
      assistantName: ASSISTANT_NAME,
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
    })
    .catch((err) => {
      resolved.logger.fatal({ err }, 'Message loop crashed unexpectedly');
      resolved.exit(1);
    });
}
