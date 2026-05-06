import {
  ASSISTANT_NAME,
  DATA_DIR,
  getCredentialBrokerRuntimeConfig,
} from '../../config/index.js';
import {
  createAgentCredentialBroker,
  ensureModelCredentialBinding,
} from '../../adapters/credentials/agent-credential-broker-factory.js';
import {
  MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
  MODEL_RUNTIME_CREDENTIAL_NAME,
} from '../../domain/models/credentials.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import { encodeGroupMessageCursor } from '../../shared/message-cursor.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { RegisteredGroup, ThinkingOverride } from '../../domain/types.js';
import { RemoteMcpDnsValidationCache } from '../../application/mcp/mcp-server-policy.js';
import { createGroupProcessor } from '../../runtime/group-processing.js';
import type { GroupProcessingDeps } from '../../runtime/group-processing-types.js';
import { listAvailableGroups } from '../../runtime/group-registry.js';
import { GroupQueue } from '../../runtime/group-queue.js';
import { parseThreadQueueKey } from '../../runtime/thread-queue-key.js';
import {
  registerGroup as registerGroupEntry,
  setGroupModelOverride as setGroupModelOverrideEntry,
  setGroupThinkingOverride as setGroupThinkingOverrideEntry,
} from '../../runtime/group-registry.js';
import type { OpsRepository } from '../../domain/repositories/ops-repo.js';
import {
  getRuntimeOpsRepository,
  getRuntimeSkillArtifactStore,
  getRuntimeStorage,
} from '../../adapters/storage/postgres/runtime-store.js';
import { collectDurableMemoryAtSessionBoundary } from '../../memory/app-memory-service.js';

export interface RuntimeApp {
  queue: GroupQueue;
  loadState: () => Promise<void>;
  saveState: () => Promise<void>;
  getOrRecoverCursor: (chatJid: string) => Promise<string>;
  registerGroup: (jid: string, group: RegisteredGroup) => Promise<void>;
  setGroupModelOverride: (
    chatJid: string,
    model: string | undefined,
  ) => Promise<void>;
  setGroupThinkingOverride: (
    chatJid: string,
    thinking: ThinkingOverride | undefined,
  ) => Promise<void>;
  getAvailableGroups: () => Promise<
    import('../../runtime/agent-spawn.js').AvailableGroup[]
  >;
  setRegisteredGroupsForTest: (groups: Record<string, RegisteredGroup>) => void;
  ensureCredentialBindingsForRegisteredGroups: () => Promise<void>;
  clearSessionForChatJid: (
    chatJid: string,
    threadId?: string | null,
  ) => Promise<void>;
  processGroupMessages: (
    chatJid: string,
    options?: { queued?: boolean },
  ) => Promise<boolean>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  setAgentCursor: (chatJid: string, timestamp: string) => void;
  setChannelRuntime: (runtime: GroupProcessingDeps['channelRuntime']) => void;
}

export interface RuntimeAppOptions {
  ensureCredentialBinding?: (input: {
    groupJid: string;
    group: RegisteredGroup;
    agentIdentifier: string;
  }) => Promise<{ created?: boolean } | undefined>;
  queue?: GroupQueue;
  runAgent?: GroupProcessingDeps['runAgent'];
  skillArtifactStore?: GroupProcessingDeps['getSkillArtifactStore'];
  mcpHostnameLookup?: GroupProcessingDeps['getMcpHostnameLookup'];
  collectSessionMemory?: GroupProcessingDeps['collectSessionMemory'];
  opsRepository?: OpsRepository;
}

export function createRuntimeApp(options: RuntimeAppOptions = {}): RuntimeApp {
  let lastTimestamp = '';
  let registeredGroups: Record<string, RegisteredGroup> = {};
  let lastAgentTimestamp: Record<string, string> = {};
  let stateSaveInFlight: Promise<void> | undefined;
  let stateSaveDirty = false;

  const queue = options.queue ?? new GroupQueue();
  const mcpDnsValidationCache = new RemoteMcpDnsValidationCache();
  let credentialBrokerPromise:
    | Promise<AgentCredentialBroker | undefined>
    | undefined;
  let credentialBrokerCacheKey = '';
  let modelAccessCredentialBindingPromise: Promise<void> | undefined;
  let modelAccessCredentialBindingCacheKey = '';
  const ops = () => options.opsRepository ?? getRuntimeOpsRepository();
  let channelRuntime: GroupProcessingDeps['channelRuntime'] = {
    hasChannel: () => false,
    supportsStreaming: () => false,
    supportsProgress: () => false,
    sendMessage: async () => {},
    sendStreamingChunk: async () => false,
    resetStreaming: () => {},
    setTyping: async () => {},
    sendProgressUpdate: async () => {},
  };

  function getCredentialBroker(): Promise<AgentCredentialBroker | undefined> {
    const brokerConfig = getCredentialBrokerRuntimeConfig();
    const cacheKey = `${brokerConfig.mode}:${brokerConfig.onecliUrl}:${brokerConfig.externalBrokerBaseUrl}`;
    if (credentialBrokerCacheKey !== cacheKey) {
      credentialBrokerPromise = undefined;
      credentialBrokerCacheKey = cacheKey;
    }
    credentialBrokerPromise ??= createAgentCredentialBroker({
      mode: brokerConfig.mode,
      onecliUrl: brokerConfig.onecliUrl,
      dataDir: DATA_DIR,
    }).catch((error) => {
      credentialBrokerPromise = undefined;
      throw error;
    });
    return credentialBrokerPromise;
  }

  async function ensureCredentialBindingAsync(
    jid: string,
    group: RegisteredGroup,
  ): Promise<void> {
    const brokerConfig = getCredentialBrokerRuntimeConfig();
    const cacheKey = `${brokerConfig.mode}:${brokerConfig.onecliUrl}:${brokerConfig.externalBrokerBaseUrl}`;
    if (modelAccessCredentialBindingCacheKey !== cacheKey) {
      modelAccessCredentialBindingPromise = undefined;
      modelAccessCredentialBindingCacheKey = cacheKey;
    }
    if (modelAccessCredentialBindingPromise) {
      return modelAccessCredentialBindingPromise;
    }
    modelAccessCredentialBindingPromise = (async () => {
      try {
        const res = options.ensureCredentialBinding
          ? await options.ensureCredentialBinding({
              groupJid: jid,
              group,
              agentIdentifier: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
            })
          : await ensureModelCredentialBinding({
              mode: brokerConfig.mode,
              onecliUrl: brokerConfig.onecliUrl,
              dataDir: DATA_DIR,
              broker: await getCredentialBroker(),
            });
        if (!res) return;
        logger.info(
          {
            jid,
            identifier: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
            name: MODEL_RUNTIME_CREDENTIAL_NAME,
            created: res.created,
            credentialMode: brokerConfig.mode,
          },
          'Model Access credential profile ensured',
        );
      } catch (err) {
        modelAccessCredentialBindingPromise = undefined;
        logger.debug(
          {
            jid,
            identifier: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
            name: MODEL_RUNTIME_CREDENTIAL_NAME,
            credentialMode: brokerConfig.mode,
            err: String(err),
          },
          'Model Access credential profile ensure skipped',
        );
      }
    })().catch((error) => {
      modelAccessCredentialBindingPromise = undefined;
      throw error;
    });
    return modelAccessCredentialBindingPromise;
  }

  function ensureCredentialBinding(jid: string, group: RegisteredGroup): void {
    void ensureCredentialBindingAsync(jid, group);
  }

  async function loadState(): Promise<void> {
    const repository = ops();
    const [loadedLastTimestamp, agentTs, loadedRegisteredGroups] =
      await Promise.all([
        repository.getRouterState('last_timestamp'),
        repository.getRouterState('last_agent_timestamp'),
        repository.getAllRegisteredGroups(),
      ]);
    lastTimestamp = loadedLastTimestamp || '';
    try {
      lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      lastAgentTimestamp = {};
    }
    registeredGroups = loadedRegisteredGroups;
    logger.info(
      { groupCount: Object.keys(registeredGroups).length },
      'State loaded',
    );
  }

  async function saveState(): Promise<void> {
    stateSaveDirty = true;
    if (stateSaveInFlight) return stateSaveInFlight;

    stateSaveInFlight = (async () => {
      do {
        stateSaveDirty = false;
        const timestamp = lastTimestamp;
        const agentTimestampJson = JSON.stringify(lastAgentTimestamp);
        await Promise.all([
          ops().setRouterState('last_timestamp', timestamp),
          ops().setRouterState('last_agent_timestamp', agentTimestampJson),
        ]);
      } while (stateSaveDirty);
    })().finally(() => {
      stateSaveInFlight = undefined;
    });

    return stateSaveInFlight;
  }

  async function getOrRecoverCursor(chatJid: string): Promise<string> {
    const existing = lastAgentTimestamp[chatJid];
    if (existing) return existing;

    const parsed = parseThreadQueueKey(chatJid);
    if (parsed.threadId) return '';

    const baseChatJid = parsed.chatJid;
    const baseExisting = lastAgentTimestamp[baseChatJid];
    if (baseExisting) {
      lastAgentTimestamp[chatJid] = baseExisting;
      return baseExisting;
    }

    const botCursor = await ops().getLastBotMessageCursor(baseChatJid);
    if (botCursor) {
      const encoded = encodeGroupMessageCursor(botCursor);
      logger.info(
        {
          chatJid: baseChatJid,
          recoveredFrom: botCursor.timestamp,
          recoveredFromId: botCursor.id,
        },
        'Recovered message cursor from last bot reply',
      );
      lastAgentTimestamp[chatJid] = encoded;
      await saveState();
      return encoded;
    }
    return '';
  }

  async function registerGroup(
    jid: string,
    group: RegisteredGroup,
  ): Promise<void> {
    await registerGroupEntry(registeredGroups, jid, group, {
      assistantName: ASSISTANT_NAME,
      persist: (persistJid, persistedGroup) =>
        ops().setRegisteredGroup(persistJid, persistedGroup),
      ensureCredentialBinding,
    });
  }

  async function setGroupModelOverride(
    chatJid: string,
    model: string | undefined,
  ): Promise<void> {
    await setGroupModelOverrideEntry(
      registeredGroups,
      chatJid,
      model,
      (jid, group) => ops().setRegisteredGroup(jid, group),
    );
  }

  async function setGroupThinkingOverride(
    chatJid: string,
    thinking: ThinkingOverride | undefined,
  ): Promise<void> {
    await setGroupThinkingOverrideEntry(
      registeredGroups,
      chatJid,
      thinking,
      (jid, group) => ops().setRegisteredGroup(jid, group),
    );
  }

  async function getAvailableGroups(): Promise<
    import('../../runtime/agent-spawn.js').AvailableGroup[]
  > {
    return listAvailableGroups(await ops().getAllChats(), registeredGroups);
  }

  function setRegisteredGroupsForTest(
    groups: Record<string, RegisteredGroup>,
  ): void {
    registeredGroups = groups;
  }

  async function ensureCredentialBindingsForRegisteredGroups(): Promise<void> {
    const firstEntry = Object.entries(registeredGroups)[0];
    if (!firstEntry) return;
    const [jid, group] = firstEntry;
    await ensureCredentialBindingAsync(jid, group);
  }

  async function clearSessionForChatJid(
    chatJid: string,
    threadId?: string | null,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;
    await ops().deleteSession(group.folder, threadId);
  }

  const groupProcessor = createGroupProcessor({
    channelRuntime: {
      hasChannel: (chatJid) => channelRuntime.hasChannel(chatJid),
      supportsStreaming: (chatJid) => channelRuntime.supportsStreaming(chatJid),
      supportsProgress: (chatJid) => channelRuntime.supportsProgress(chatJid),
      sendMessage: (chatJid, rawText, options) =>
        channelRuntime.sendMessage(chatJid, rawText, options),
      sendStreamingChunk: (chatJid, rawText, options) =>
        channelRuntime.sendStreamingChunk(chatJid, rawText, options),
      resetStreaming: (chatJid) => channelRuntime.resetStreaming(chatJid),
      setTyping: (chatJid, isTyping) =>
        channelRuntime.setTyping(chatJid, isTyping),
      sendProgressUpdate: (chatJid, text, options) =>
        channelRuntime.sendProgressUpdate(chatJid, text, options),
    },
    getGroup: (chatJid) => registeredGroups[chatJid],
    clearSession: async (groupFolder, threadId) => {
      await ops().deleteSession(groupFolder, threadId);
    },
    getCursor: getOrRecoverCursor,
    setCursor: (chatJid, timestamp) => {
      lastAgentTimestamp[chatJid] = timestamp;
    },
    saveState,
    setGroupModelOverride,
    setGroupThinkingOverride,
    getAvailableGroups,
    getRegisteredJids: () => new Set(Object.keys(registeredGroups)),
    opsRepository: options.opsRepository,
    getOpsRepository: ops,
    queue: {
      closeStdin: (chatJid) => queue.closeStdin(chatJid),
      notifyIdle: (chatJid) => queue.notifyIdle(chatJid),
      stopGroup: (chatJid) => queue.stopGroup(chatJid),
      registerProcess: (
        groupJid,
        proc,
        runHandle,
        groupFolder,
        stopAliasJids,
        threadId,
      ) =>
        queue.registerProcess(
          groupJid,
          proc,
          runHandle,
          groupFolder,
          stopAliasJids,
          threadId,
        ),
    },
    runAgent: options.runAgent,
    getCredentialBroker,
    getToolRepository: () => getRuntimeStorage().repositories.tools,
    getSkillRepository: () => getRuntimeStorage().repositories.skills,
    getMcpServerRepository: () => getRuntimeStorage().repositories.mcpServers,
    getMcpHostnameLookup: options.mcpHostnameLookup,
    getMcpDnsValidationCache: () => mcpDnsValidationCache,
    getSkillArtifactStore:
      options.skillArtifactStore ?? getRuntimeSkillArtifactStore,
    collectSessionMemory:
      options.collectSessionMemory ?? collectDurableMemoryAtSessionBoundary,
  });

  return {
    queue,
    loadState,
    saveState,
    getOrRecoverCursor,
    registerGroup,
    setGroupModelOverride,
    setGroupThinkingOverride,
    getAvailableGroups,
    setRegisteredGroupsForTest,
    ensureCredentialBindingsForRegisteredGroups,
    clearSessionForChatJid,
    processGroupMessages: (chatJid, options) =>
      groupProcessor.processGroupMessages(chatJid, options),
    getRegisteredGroups: () => registeredGroups,
    getLastTimestamp: () => lastTimestamp,
    setLastTimestamp: (timestamp) => {
      lastTimestamp = timestamp;
    },
    setAgentCursor: (chatJid, timestamp) => {
      lastAgentTimestamp[chatJid] = timestamp;
    },
    setChannelRuntime: (runtime) => {
      channelRuntime = runtime;
    },
  };
}

let defaultRuntimeApp: RuntimeApp | null = null;

export function getDefaultRuntimeApp(
  options: RuntimeAppOptions = {},
): RuntimeApp {
  if (!defaultRuntimeApp) {
    defaultRuntimeApp = createRuntimeApp(options);
  }
  return defaultRuntimeApp;
}

export function getAvailableGroups(): Promise<
  import('../../runtime/agent-spawn.js').AvailableGroup[]
> {
  return getDefaultRuntimeApp().getAvailableGroups();
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  getDefaultRuntimeApp().setRegisteredGroupsForTest(groups);
}
