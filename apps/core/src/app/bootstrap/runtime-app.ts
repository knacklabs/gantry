import {
  ASSISTANT_NAME,
  getCredentialBrokerRuntimeConfig,
  getRuntimeQueueConfig,
  getRuntimeSettingsForConfig,
} from '../../config/index.js';
import {
  createAgentCredentialBroker,
  ensureAgentCredentialBinding,
  ensureModelCredentialBinding,
} from '../../adapters/credentials/agent-credential-broker-factory.js';
import {
  MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
  MODEL_RUNTIME_CREDENTIAL_NAME,
} from '../../domain/models/credentials.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import { encodeGroupMessageCursor } from '../../shared/message-cursor.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { ConversationRoute, ThinkingOverride } from '../../domain/types.js';
import { RemoteMcpDnsValidationCache } from '../../application/mcp/mcp-server-policy.js';
import { createGroupProcessor } from '../../runtime/group-processing.js';
import type { GroupProcessingDeps } from '../../runtime/group-processing-types.js';
import { listAvailableGroups } from '../../runtime/group-registry.js';
import { GroupQueue } from '../../runtime/group-queue.js';
import { parseThreadQueueKey } from '../../shared/thread-queue-key.js';
import {
  registerGroup as registerGroupEntry,
  setGroupModelOverride as setGroupModelOverrideEntry,
  setGroupThinkingOverride as setGroupThinkingOverrideEntry,
} from '../../runtime/group-registry.js';
import type {
  RuntimeAgentSessionRepository,
  RuntimeChatMetadataRepository,
  RuntimeConversationRouteRepository,
  RuntimeMessageRepository,
  RuntimeRouterStateRepository,
} from '../../domain/repositories/ops-repo.js';
import {
  getRuntimeRepositories,
  getRuntimeSkillArtifactStore,
  getRuntimeStorage,
} from '../../adapters/storage/postgres/runtime-store.js';
import { AppMemoryService } from '../../memory/app-memory-service.js';
import { collectDurableMemoryAtBoundary } from '../../memory/app-memory-session-boundary-collector.js';
import { memoryAgentIdForWorkspaceFolder } from '../../memory/app-memory-boundaries.js';
import {
  createDefaultAgentExecutionAdapterRegistry,
  createDefaultMemoryLlmClient,
  createDefaultRunnerSandboxProvider,
} from '../../adapters/llm/default-runtime-adapters.js';
import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../../application/agent-execution/agent-execution-adapter-registry.js';
import { registerMemoryLlmClient } from '../../memory/memory-llm-port.js';
import type { RunnerSandboxProvider } from '../../shared/runner-sandbox-provider.js';

export type RuntimeAppRepository = RuntimeRouterStateRepository &
  RuntimeMessageRepository &
  RuntimeConversationRouteRepository &
  RuntimeChatMetadataRepository &
  RuntimeAgentSessionRepository;

export interface RuntimeApp {
  executionAdapter: AgentExecutionAdapter;
  executionAdapters: AgentExecutionAdapterRegistry;
  runnerSandboxProvider: RunnerSandboxProvider;
  queue: GroupQueue;
  loadState: () => Promise<void>;
  saveState: () => Promise<void>;
  getOrRecoverCursor: (chatJid: string) => Promise<string>;
  registerGroup: (jid: string, group: ConversationRoute) => Promise<void>;
  projectConversationRoute: (
    jid: string,
    group: ConversationRoute,
  ) => Promise<void>;
  unregisterConversationRoute: (jid: string) => Promise<void>;
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
  setConversationRoutesForTest: (
    groups: Record<string, ConversationRoute>,
  ) => void;
  ensureCredentialBindingsForConversationRoutes: () => Promise<void>;
  getCredentialBroker: () => Promise<AgentCredentialBroker | undefined>;
  clearSessionForChatJid: (
    chatJid: string,
    threadId?: string | null,
    metadata?: { memoryUserId?: string },
  ) => Promise<void>;
  processGroupMessages: (
    chatJid: string,
    options?: {
      queued?: boolean;
      existingRunId?: string;
      existingRunLeaseToken?: string;
      existingRunLeaseWorkerInstanceId?: string;
      existingRunLeaseFencingVersion?: number;
      onRunResult?: (result: 'success' | 'error' | 'stopped') => void;
    },
  ) => Promise<boolean>;
  getConversationRoutes: () => Record<string, ConversationRoute>;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  setAgentCursor: (chatJid: string, timestamp: string) => void;
  setChannelRuntime: (runtime: GroupProcessingDeps['channelRuntime']) => void;
}

export interface RuntimeAppOptions {
  ensureCredentialBinding?: (input: {
    groupJid: string;
    group: ConversationRoute;
    agentIdentifier: string;
    agentName: string;
  }) => Promise<{ created?: boolean } | undefined>;
  queue?: GroupQueue;
  runAgent?: GroupProcessingDeps['runAgent'];
  skillArtifactStore?: GroupProcessingDeps['getSkillArtifactStore'];
  mcpHostnameLookup?: GroupProcessingDeps['getMcpHostnameLookup'];
  collectSessionMemory?: GroupProcessingDeps['collectSessionMemory'];
  publishRuntimeEvent?: GroupProcessingDeps['publishRuntimeEvent'];
  executionAdapter?: AgentExecutionAdapter;
  executionAdapters?: AgentExecutionAdapterRegistry;
  runnerSandboxProvider?: RunnerSandboxProvider;
  opsRepository?: RuntimeAppRepository;
}

export function createRuntimeApp(options: RuntimeAppOptions = {}): RuntimeApp {
  let lastTimestamp = '';
  let conversationRoutes: Record<string, ConversationRoute> = {};
  let lastAgentTimestamp: Record<string, string> = {};
  let stateSaveInFlight: Promise<void> | undefined;
  let stateSaveDirty = false;

  const queue = options.queue ?? new GroupQueue(getRuntimeQueueConfig());
  const executionAdapters =
    options.executionAdapters ?? createDefaultAgentExecutionAdapterRegistry();
  const executionAdapter =
    options.executionAdapter ?? executionAdapters.list()[0];
  if (!executionAdapter) {
    throw new Error('Runtime requires at least one model execution adapter.');
  }
  const runnerSandboxProvider =
    options.runnerSandboxProvider ??
    createDefaultRunnerSandboxProvider(
      getRuntimeSettingsForConfig().runtime.sandbox,
    );
  registerMemoryLlmClient(createDefaultMemoryLlmClient());
  const mcpDnsValidationCache = new RemoteMcpDnsValidationCache();
  let credentialBrokerPromise:
    | Promise<AgentCredentialBroker | undefined>
    | undefined;
  let credentialBrokerConfigKey = '';
  const credentialBindingPromises = new Map<string, Promise<void>>();
  const ops = () => options.opsRepository ?? getRuntimeRepositories();
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
    const configKey = `${brokerConfig.mode}:${brokerConfig.gatewayBindHost}`;
    if (credentialBrokerConfigKey !== configKey) {
      void credentialBrokerPromise
        ?.then((broker) => broker?.close?.())
        .catch((error) => {
          logger.warn(
            { err: error },
            'Failed to close replaced credential broker',
          );
        });
      credentialBrokerPromise = undefined;
      credentialBrokerConfigKey = configKey;
    }
    credentialBrokerPromise ??= createAgentCredentialBroker({
      mode: brokerConfig.mode,
      modelCredentials: getRuntimeStorage().repositories.modelCredentials,
      gatewayBindHost: brokerConfig.gatewayBindHost,
      publishRuntimeEvent: options.publishRuntimeEvent,
    }).catch((error) => {
      credentialBrokerPromise = undefined;
      throw error;
    });
    return credentialBrokerPromise;
  }

  async function ensureCredentialProfileBinding(input: {
    jid: string;
    group: ConversationRoute;
    brokerConfig: ReturnType<typeof getCredentialBrokerRuntimeConfig>;
    identifier: string;
    name: string;
    modelRuntime: boolean;
  }): Promise<void> {
    const { jid, group, brokerConfig, identifier, name, modelRuntime } = input;
    const configKey = `${brokerConfig.mode}:${brokerConfig.gatewayBindHost}`;
    const bindingConfigKey = `${configKey}:${identifier}`;
    const existing = credentialBindingPromises.get(bindingConfigKey);
    if (existing) {
      return existing;
    }
    const bindingPromise = (async () => {
      try {
        const res = options.ensureCredentialBinding
          ? await options.ensureCredentialBinding({
              groupJid: jid,
              group,
              agentIdentifier: identifier,
              agentName: name,
            })
          : modelRuntime
            ? await ensureModelCredentialBinding({
                mode: brokerConfig.mode,
                broker: await getCredentialBroker(),
                modelCredentials:
                  getRuntimeStorage().repositories.modelCredentials,
                gatewayBindHost: brokerConfig.gatewayBindHost,
                publishRuntimeEvent: options.publishRuntimeEvent,
              })
            : await ensureAgentCredentialBinding({
                mode: brokerConfig.mode,
                broker: await getCredentialBroker(),
                modelCredentials:
                  getRuntimeStorage().repositories.modelCredentials,
                gatewayBindHost: brokerConfig.gatewayBindHost,
                publishRuntimeEvent: options.publishRuntimeEvent,
                name,
                identifier,
              });
        if (!res) return;
        logger.info(
          {
            jid,
            identifier,
            name,
            created: res.created,
            credentialMode: brokerConfig.mode,
          },
          'Gantry Model Gateway access ensured',
        );
      } catch (err) {
        logger.debug(
          {
            jid,
            identifier,
            name,
            credentialMode: brokerConfig.mode,
            err: String(err),
          },
          'Gantry Model Gateway access ensure skipped',
        );
        credentialBindingPromises.delete(bindingConfigKey);
      }
    })().catch((error) => {
      credentialBindingPromises.delete(bindingConfigKey);
      throw error;
    });
    credentialBindingPromises.set(bindingConfigKey, bindingPromise);
    return bindingPromise;
  }

  async function ensureCredentialBindingAsync(
    jid: string,
    group: ConversationRoute,
  ): Promise<void> {
    const brokerConfig = getCredentialBrokerRuntimeConfig();
    await ensureCredentialProfileBinding({
      jid,
      group,
      brokerConfig,
      identifier: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
      name: MODEL_RUNTIME_CREDENTIAL_NAME,
      modelRuntime: true,
    });
    await ensureCredentialProfileBinding({
      jid,
      group,
      brokerConfig,
      identifier: memoryAgentIdForWorkspaceFolder(group.folder),
      name: group.name || group.folder,
      modelRuntime: false,
    });
  }

  function ensureCredentialBinding(
    jid: string,
    group: ConversationRoute,
  ): void {
    void ensureCredentialBindingAsync(jid, group);
  }

  async function loadState(): Promise<void> {
    const repository = ops();
    const [loadedLastTimestamp, agentTs, loadedRoutes] = await Promise.all([
      repository.getRouterState('last_timestamp'),
      repository.getRouterState('last_agent_timestamp'),
      repository.getAllConversationRoutes(),
    ]);
    lastTimestamp = loadedLastTimestamp || '';
    try {
      lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      lastAgentTimestamp = {};
    }
    conversationRoutes = loadedRoutes;
    logger.info(
      { groupCount: Object.keys(conversationRoutes).length },
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
    group: ConversationRoute,
  ): Promise<void> {
    await registerGroupEntry(conversationRoutes, jid, group, {
      assistantName: ASSISTANT_NAME,
      persist: (persistJid, persistedGroup) =>
        ops().setConversationRoute(persistJid, persistedGroup),
      ensureCredentialBinding,
      getFileArtifactStore: () => getRuntimeStorage().fileArtifacts,
    });
  }

  async function projectConversationRoute(
    jid: string,
    group: ConversationRoute,
  ): Promise<void> {
    await registerGroupEntry(conversationRoutes, jid, group, {
      assistantName: ASSISTANT_NAME,
      persist: async () => undefined,
      ensureCredentialBinding,
      getFileArtifactStore: () => getRuntimeStorage().fileArtifacts,
    });
  }

  async function unregisterConversationRoute(jid: string): Promise<void> {
    delete conversationRoutes[jid];
    queue.stopGroup(jid);
    await ops().deleteConversationRoute(jid);
  }

  async function setGroupModelOverride(
    chatJid: string,
    model: string | undefined,
  ): Promise<void> {
    await setGroupModelOverrideEntry(
      conversationRoutes,
      chatJid,
      model,
      (jid, group) => ops().setConversationRoute(jid, group),
    );
  }

  async function setGroupThinkingOverride(
    chatJid: string,
    thinking: ThinkingOverride | undefined,
  ): Promise<void> {
    await setGroupThinkingOverrideEntry(
      conversationRoutes,
      chatJid,
      thinking,
      (jid, group) => ops().setConversationRoute(jid, group),
    );
  }

  async function getAvailableGroups(): Promise<
    import('../../runtime/agent-spawn.js').AvailableGroup[]
  > {
    return listAvailableGroups(await ops().getAllChats(), conversationRoutes);
  }

  function setConversationRoutesForTest(
    groups: Record<string, ConversationRoute>,
  ): void {
    conversationRoutes = groups;
  }

  async function ensureCredentialBindingsForConversationRoutes(): Promise<void> {
    const entries = Object.entries(conversationRoutes);
    if (entries.length === 0) return;
    const [firstJid, firstGroup] = entries[0];
    await ensureCredentialProfileBinding({
      jid: firstJid,
      group: firstGroup,
      brokerConfig: getCredentialBrokerRuntimeConfig(),
      identifier: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
      name: MODEL_RUNTIME_CREDENTIAL_NAME,
      modelRuntime: true,
    });
    for (const [jid, group] of entries) {
      await ensureCredentialProfileBinding({
        jid,
        group,
        brokerConfig: getCredentialBrokerRuntimeConfig(),
        identifier: memoryAgentIdForWorkspaceFolder(group.folder),
        name: group.name || group.folder,
        modelRuntime: false,
      });
    }
  }

  async function clearSessionForChatJid(
    chatJid: string,
    threadId?: string | null,
    metadata: { memoryUserId?: string } = {},
  ): Promise<void> {
    const group = conversationRoutes[chatJid];
    if (!group) return;
    await ops().deleteSession(group.folder, threadId, {
      conversationJid: chatJid,
      conversationKind: group.conversationKind,
      memoryUserId: metadata.memoryUserId,
    });
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
      isControlApproverAllowed: (input) =>
        channelRuntime.isControlApproverAllowed?.(input) ??
        Promise.resolve(false),
    },
    getGroup: (chatJid) => conversationRoutes[chatJid],
    clearSession: async (workspaceFolder, threadId, metadata) => {
      await ops().deleteSession(workspaceFolder, threadId, metadata);
    },
    getCursor: getOrRecoverCursor,
    setCursor: (chatJid, timestamp) => {
      lastAgentTimestamp[chatJid] = timestamp;
    },
    saveState,
    setGroupModelOverride,
    setGroupThinkingOverride,
    getAvailableGroups,
    getRegisteredJids: () => new Set(Object.keys(conversationRoutes)),
    opsRepository: options.opsRepository,
    getRuntimeRepository: ops,
    queue: {
      closeStdin: (chatJid) => queue.closeStdin(chatJid),
      notifyIdle: (chatJid) => queue.notifyIdle(chatJid),
      stopGroup: (chatJid) => queue.stopGroup(chatJid),
      registerProcess: (
        groupJid,
        proc,
        runHandle,
        workspaceFolder,
        stopAliasJids,
        threadId,
        registerOptions,
      ) =>
        queue.registerProcess(
          groupJid,
          proc,
          runHandle,
          workspaceFolder,
          stopAliasJids,
          threadId,
          registerOptions,
        ),
    },
    runAgent: options.runAgent,
    getCredentialBroker,
    getToolRepository: () => getRuntimeStorage().repositories.tools,
    getSkillRepository: () => getRuntimeStorage().repositories.skills,
    getMcpServerRepository: () => getRuntimeStorage().repositories.mcpServers,
    getCapabilitySecretRepository: () =>
      getRuntimeStorage().repositories.capabilitySecrets,
    getMcpHostnameLookup: options.mcpHostnameLookup,
    getMcpDnsValidationCache: () => mcpDnsValidationCache,
    getSkillArtifactStore:
      options.skillArtifactStore ?? getRuntimeSkillArtifactStore,
    collectSessionMemory:
      options.collectSessionMemory ?? collectRuntimeSessionMemory,
    publishRuntimeEvent: options.publishRuntimeEvent,
    executionAdapter,
    executionAdapters,
    runnerSandboxProvider,
  });

  return {
    executionAdapter,
    executionAdapters,
    runnerSandboxProvider,
    queue,
    loadState,
    saveState,
    getOrRecoverCursor,
    registerGroup,
    projectConversationRoute,
    unregisterConversationRoute,
    setGroupModelOverride,
    setGroupThinkingOverride,
    getAvailableGroups,
    setConversationRoutesForTest,
    ensureCredentialBindingsForConversationRoutes,
    getCredentialBroker,
    clearSessionForChatJid,
    processGroupMessages: (chatJid, options) =>
      groupProcessor.processGroupMessages(chatJid, options),
    getConversationRoutes: () => conversationRoutes,
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

export const collectRuntimeSessionMemory: import('../../domain/ports/session-memory-collector.js').SessionMemoryCollector =
  async (input) => {
    const { repositories } = getRuntimeStorage();
    const memoryService = AppMemoryService.getInstance();
    return collectDurableMemoryAtBoundary(input, {
      repositories,
      memory: {
        recordEvidence: (value) => memoryService.recordEvidence(value),
      },
    });
  };

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
export function _setConversationRoutes(
  groups: Record<string, ConversationRoute>,
): void {
  getDefaultRuntimeApp().setConversationRoutesForTest(groups);
}
