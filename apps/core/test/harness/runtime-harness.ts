import fs from 'fs';
import path from 'path';

import { vi } from 'vitest';

import {
  createFakeAgentRunner,
  FakeAgentRunnerOptions,
} from './fake-agent-runner.js';
import {
  createFakeChannelRuntime,
  FakeChannelRuntimeOptions,
} from './fake-channel.js';
import { createTempRuntimeHome } from './runtime-home.js';

interface HarnessOptions {
  configureSettings?: (settings: any) => void;
  fakeAgent?: FakeAgentRunnerOptions;
  fakeChannel?: FakeChannelRuntimeOptions;
}

interface RegisterGroupInput {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  isMain?: boolean;
  requiresTrigger?: boolean;
}

interface InboundMessageInput {
  id?: string;
  chatJid: string;
  sender: string;
  content: string;
  isFromMe?: boolean;
  senderName?: string;
  threadId?: string;
  timestamp?: string;
}

export async function createHermeticRuntimeHarness(
  options: HarnessOptions = {},
) {
  const runtimeHome = await createTempRuntimeHome({
    configureSettings: options.configureSettings,
  });

  vi.resetModules();

  const configModule = await import('@core/core/config.js');
  const db = await import('@core/storage/db.js');
  const runtimeAppModule = await import('@core/bootstrap/runtime-app.js');
  const messageCursor = await import('@core/core/message-cursor.js');
  const messageLoop = await import('@core/runtime/message-loop.js');
  const scheduler = await import('@core/runtime/task-scheduler.js');
  const ipc = await import('@core/runtime/ipc.js');
  const ipcAuth = await import('@core/runtime/ipc-auth.js');

  db.initDatabase();

  const fakeAgent = createFakeAgentRunner(options.fakeAgent);
  const app = runtimeAppModule.createRuntimeApp({
    onecli: {
      ensureAgent: async () => ({ created: false }),
    } as any,
    runAgent: fakeAgent.runAgent as any,
  });
  app.loadState();

  const channel = createFakeChannelRuntime(
    (chatJid) => Boolean(app.getRegisteredGroups()[chatJid]),
    options.fakeChannel,
  );
  app.setChannelRuntime(channel.runtime);
  app.queue.setProcessMessagesFn((chatJid) =>
    app.processGroupMessages(chatJid, { queued: true }),
  );

  let messageCounter = 0;
  let ipcWatcherStarted = false;

  const registerGroup = (input: RegisterGroupInput): void => {
    app.registerGroup(input.jid, {
      name: input.name,
      folder: input.folder,
      trigger: input.trigger,
      added_at: new Date().toISOString(),
      isMain: input.isMain,
      requiresTrigger: input.requiresTrigger,
    });
    fs.mkdirSync(
      path.join(runtimeHome.runtimeHome, 'data', 'ipc', input.folder),
      { recursive: true },
    );
  };

  const storeInboundMessage = (input: InboundMessageInput): void => {
    messageCounter += 1;
    const timestamp =
      input.timestamp ?? new Date(Date.now() + messageCounter).toISOString();
    db.storeChatMetadata(
      input.chatJid,
      timestamp,
      input.chatJid,
      input.chatJid.startsWith('tg:') ? 'telegram' : 'slack',
      true,
    );
    db.storeMessage({
      id: input.id ?? `msg-${messageCounter}`,
      chat_jid: input.chatJid,
      sender: input.sender,
      sender_name: input.senderName ?? input.sender,
      content: input.content,
      timestamp,
      is_from_me: input.isFromMe === true,
      is_bot_message: false,
      ...(input.threadId ? { thread_id: input.threadId } : {}),
    });
  };

  const pollMessagesOnce = async (): Promise<void> => {
    await messageLoop.runMessagePollingTick({
      assistantName: configModule.ASSISTANT_NAME,
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
      hasChannel: (chatJid) => channel.runtime.hasChannel(chatJid),
      setTyping: (chatJid, isTyping) =>
        channel.runtime.setTyping(chatJid, isTyping),
      sendProgressUpdate: (chatJid, text, options) =>
        channel.runtime.sendProgressUpdate(chatJid, text, options),
      queue: app.queue,
      handleActiveControlCommand: async ({ chatJid, command, message }) => {
        if (command.kind !== 'stop' && command.kind !== 'new') {
          return false;
        }
        if (!app.queue.isGroupActive(chatJid)) {
          return false;
        }
        if (!app.queue.stopGroup(chatJid)) {
          return false;
        }
        if (command.kind === 'new') {
          app.clearSessionForChatJid(chatJid);
        }
        app.setAgentCursor(
          chatJid,
          messageCursor.encodeGroupMessageCursor(
            messageCursor.toGroupMessageCursor(message),
          ),
        );
        app.saveState();
        const threadId =
          typeof message.thread_id === 'string' && message.thread_id.trim()
            ? message.thread_id.trim()
            : undefined;
        await channel.runtime.sendMessage(
          chatJid,
          command.kind === 'stop'
            ? 'Stopping current run.'
            : 'Started a fresh session.',
          threadId ? { threadId } : undefined,
        );
        return true;
      },
    });
  };

  const runSchedulerOnce = async (
    options: { awaitTasks?: boolean; useRealQueue?: boolean } = {},
  ): Promise<void> => {
    const taskPromises: Promise<void>[] = [];
    const immediateQueue = {
      enqueueTask: (
        _groupJid: string,
        _taskId: string,
        fn: () => Promise<void>,
      ) => {
        const promise = fn();
        taskPromises.push(promise);
        if (options.awaitTasks === false) {
          void promise;
        }
      },
    } as any;
    const queue = options.useRealQueue ? app.queue : immediateQueue;

    await scheduler.runSchedulerTick({
      registeredGroups: () => app.getRegisteredGroups(),
      queue,
      onProcess: (jid, proc, containerName, groupFolder, stopAliasJids) =>
        app.queue.registerProcess(
          jid,
          proc,
          containerName,
          groupFolder,
          stopAliasJids,
        ),
      sendMessage: (jid, text) => channel.runtime.sendMessage(jid, text),
      sendStreamingChunk: (jid, text, chunkOptions) =>
        channel.runtime.sendStreamingChunk(jid, text, chunkOptions),
      resetStreaming: (jid) => channel.runtime.resetStreaming(jid),
      onSchedulerChanged: () => {},
      runAgent: fakeAgent.runAgent as any,
    });
    if (options.awaitTasks !== false) {
      await Promise.all(taskPromises);
    }
  };

  const startIpcWatcher = (): void => {
    if (ipcWatcherStarted) return;
    ipcWatcherStarted = true;
    ipc.startIpcWatcher({
      sendMessage: (jid, text) => channel.runtime.sendMessage(jid, text),
      registeredGroups: () => app.getRegisteredGroups(),
      registerGroup: app.registerGroup,
      syncGroups: async () => {},
      getAvailableGroups: app.getAvailableGroups,
      writeGroupsSnapshot: () => {},
      onSchedulerChanged: () => {},
      requestPermissionApproval: (request) =>
        (channel.runtime as any).requestPermissionApproval('tg:main', request),
      requestUserAnswer: (request) =>
        (channel.runtime as any).requestUserAnswer('tg:main', request),
    });
  };

  const writeJsonFile = (dir: string, payload: any): string => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${Math.random()}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, file);
    return file;
  };

  const writeRawFile = (
    sourceGroup: string,
    namespace: string,
    filename: string,
    content: string,
  ): string => {
    const dir = groupIpcDir(sourceGroup, namespace);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, content);
    return filePath;
  };

  const groupIpcDir = (sourceGroup: string, namespace?: string): string => {
    const base = path.join(runtimeHome.runtimeHome, 'data', 'ipc', sourceGroup);
    return namespace ? path.join(base, namespace) : base;
  };

  const withAuth = (sourceGroup: string, payload: any): any => ({
    authToken: ipcAuth.computeIpcAuthToken(sourceGroup),
    ...payload,
  });
  const authTokenFor = (sourceGroup: string): string =>
    ipcAuth.computeIpcAuthToken(sourceGroup);

  const writeIpcMessageRequest = (
    sourceGroup: string,
    payload: any,
    options: { auth?: boolean } = {},
  ): void => {
    const messagesDir = path.join(
      runtimeHome.runtimeHome,
      'data',
      'ipc',
      sourceGroup,
      'messages',
    );
    writeJsonFile(messagesDir, {
      ...(options.auth === false ? {} : withAuth(sourceGroup, {})),
      type: 'message',
      ...payload,
    });
  };

  const writeIpcTaskRequest = (
    sourceGroup: string,
    payload: any,
    options: { auth?: boolean } = {},
  ): void => {
    const tasksDir = path.join(
      runtimeHome.runtimeHome,
      'data',
      'ipc',
      sourceGroup,
      'tasks',
    );
    writeJsonFile(tasksDir, {
      ...(options.auth === false ? {} : withAuth(sourceGroup, {})),
      ...payload,
    });
  };

  const writePermissionRequest = (
    sourceGroup: string,
    payload: any,
    options: { auth?: boolean } = {},
  ): void => {
    writeJsonFile(groupIpcDir(sourceGroup, 'permission-requests'), {
      ...(options.auth === false ? {} : withAuth(sourceGroup, {})),
      sourceGroup,
      ...payload,
    });
  };

  const writeUserQuestionRequest = (
    sourceGroup: string,
    payload: any,
    options: { auth?: boolean } = {},
  ): void => {
    writeJsonFile(groupIpcDir(sourceGroup, 'user-questions'), {
      ...(options.auth === false ? {} : withAuth(sourceGroup, {})),
      sourceGroup,
      ...payload,
    });
  };

  const writeMemoryRequest = (
    sourceGroup: string,
    payload: any,
    options: { auth?: boolean } = {},
  ): void => {
    writeJsonFile(groupIpcDir(sourceGroup, 'memory-requests'), {
      ...(options.auth === false ? {} : withAuth(sourceGroup, {})),
      ...payload,
    });
  };

  const readIpcJson = <T = any>(
    sourceGroup: string,
    namespace: string,
    filename: string,
  ): T | undefined => {
    const filePath = path.join(groupIpcDir(sourceGroup, namespace), filename);
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  };

  const listIpcJson = <T = any>(
    sourceGroup: string,
    namespace: string,
  ): T[] => {
    const dir = groupIpcDir(sourceGroup, namespace);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')))
      .filter((value): value is T => Boolean(value));
  };

  const listIpcFiles = (sourceGroup: string, namespace: string): string[] => {
    const dir = groupIpcDir(sourceGroup, namespace);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort();
  };

  const ipcFileExists = (
    sourceGroup: string,
    namespace: string,
    filename: string,
  ): boolean =>
    fs.existsSync(path.join(groupIpcDir(sourceGroup, namespace), filename));

  const listIpcErrorFiles = (): string[] => {
    const dir = path.join(runtimeHome.runtimeHome, 'data', 'ipc', 'errors');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort();
  };

  const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 5_000,
  ): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const cleanup = (): void => {
    ipc.stopIpcWatcher();
    void app.queue.shutdown(0);
    try {
      db._closeDatabase();
    } catch {
      // no-op
    }
    runtimeHome.cleanup();
  };

  return {
    runtimeHome: runtimeHome.runtimeHome,
    app,
    db,
    channel,
    fakeAgent,
    registerGroup,
    storeInboundMessage,
    pollMessagesOnce,
    runSchedulerOnce,
    startIpcWatcher,
    writeIpcMessageRequest,
    writeIpcTaskRequest,
    writePermissionRequest,
    writeUserQuestionRequest,
    writeMemoryRequest,
    writeRawFile,
    readIpcJson,
    listIpcJson,
    listIpcFiles,
    listIpcErrorFiles,
    ipcFileExists,
    groupIpcDir,
    authTokenFor,
    waitFor,
    cleanup,
  };
}
