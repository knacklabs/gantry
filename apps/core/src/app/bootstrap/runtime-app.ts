import {
  ASSISTANT_NAME,
  STORAGE_POSTGRES_SCHEMA,
  STORAGE_POSTGRES_URL,
  getCredentialBrokerRuntimeConfig,
  getDefaultModelConfig,
  getRuntimeQueueConfig,
  getRuntimeSettingsForConfig,
  getSelectedAgentHarness,
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
import { resolveAgentLockStatus } from '../../config/profiles.js';
import {
  ensureRouteProfileDefaults,
  listAvailableGroups,
  registerGroup as registerGroupEntry,
  setGroupModelOverride as setGroupModelOverrideEntry,
  setGroupPermissionModeOverride as setGroupPermissionModeOverrideEntry,
  setGroupThinkingOverride as setGroupThinkingOverrideEntry,
} from '../../runtime/group-registry.js';
import { GroupQueue } from '../../runtime/group-queue.js';
import { conversationRouteKeysForRemoval } from '../../runtime/conversation-route-removal.js';
import {
  makeAgentThreadQueueKey,
  makeThreadQueueKey,
  parseAgentThreadQueueKey,
} from '../../shared/thread-queue-key.js';
import { appIdFromConversationJid } from '../../shared/app-conversation-jid.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import { resolveConversationRoute } from './runtime-app-routes.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import type {
  RuntimeAgentSessionRepository,
  RuntimeChatMetadataRepository,
  RuntimeConversationRouteRepository,
  RuntimeMessageRepository,
  RuntimeRouterStateRepository,
} from '../../domain/repositories/ops-repo.js';
import {
  getConfiguredModelProvidersForApp,
  getRuntimeRepositories,
  getRuntimeSkillArtifactStore,
  getRuntimeStorage,
  resolveRuntimePersonIdentity,
} from '../../adapters/storage/postgres/runtime-store.js';
import type { ProcessRole } from './roles/process-role.js';
import { applyHostCapacityToQueuePolicy } from '../../shared/host-capacity.js';
import { AppMemoryService } from '../../memory/app-memory-service.js';
import { collectDurableMemoryAtBoundary } from '../../memory/app-memory-session-boundary-collector.js';
import { memoryAgentIdForWorkspaceFolder } from '../../memory/app-memory-boundaries.js';
import * as defaultLlmAdapters from '../../adapters/llm/default-runtime-adapters.js';
import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../../application/agent-execution/agent-execution-adapter-registry.js';
import { registerMemoryLlmClient } from '../../memory/memory-llm-port.js';
import type { RunnerSandboxProvider } from '../../shared/runner-sandbox-provider.js';
import { createMutableChannelRuntime } from './runtime-app-channel-runtime.js';
import { resolveGroupRouteExecutionProviderId } from '../../runtime/group-initial-execution-provider.js';
import { resolveRuntimeDefaultAdapters } from './runtime-default-adapters.js';
import type { AvailableGroup } from '../../runtime/agent-spawn.js';
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
  setGroupPermissionModeOverride: GroupProcessingDeps['setGroupPermissionModeOverride'];
  getAvailableGroups: () => Promise<AvailableGroup[]>;
  setConversationRoutesForTest: (
    groups: Record<string, ConversationRoute>,
  ) => void;
  ensureCredentialBindingsForConversationRoutes: () => Promise<void>;
  getCredentialBroker: () => Promise<AgentCredentialBroker | undefined>;
  clearSessionForChatJid: (
    chatJid: string,
    threadId?: string | null,
    metadata?: { memoryUserId?: string; providerAccountId?: string | null },
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
      onFirstProgress?: (input: {
        jid: string;
        messageRef: string;
      }) => Promise<void> | void;
    },
  ) => Promise<boolean>;
  getConversationRoutes: () => Record<string, ConversationRoute>;
  resolveExecutionProviderId: (
    route: Pick<ConversationRoute, 'agentConfig' | 'folder'>,
    chatJid: string,
  ) => Promise<ExecutionProviderId>;
  setAgentCursor: (chatJid: string, timestamp: string) => void;
  setChannelRuntime: (runtime: GroupProcessingDeps['channelRuntime']) => void;
  setProviderIdNormalizer?: (normalize: (providerId: string) => string) => void;
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
  processRole?: ProcessRole;
}
export function createRuntimeApp(options: RuntimeAppOptions = {}): RuntimeApp {
  let conversationRoutes: Record<string, ConversationRoute> = {};
  let lastAgentTimestamp: Record<string, string> = {};
  let normalizeProviderId: GroupProcessingDeps['normalizeProviderId'];
  let stateSaveInFlight: Promise<void> | undefined;
  let stateSaveDirty = false;
  const queue =
    options.queue ??
    new GroupQueue(
      applyHostCapacityToQueuePolicy(
        getRuntimeQueueConfig(),
        options.processRole,
      ),
    );
  const {
    executionAdapters,
    executionAdapter,
    runnerSandboxProvider,
    memoryLlmClient,
  } = resolveRuntimeDefaultAdapters({
    executionAdapters: options.executionAdapters,
    executionAdapter: options.executionAdapter,
    runnerSandboxProvider: options.runnerSandboxProvider,
    sandboxSettings: getRuntimeSettingsForConfig().runtime.sandbox,
    databaseUrl: STORAGE_POSTGRES_URL,
    databaseSchema: STORAGE_POSTGRES_SCHEMA,
    getEgressDenylist: () =>
      getRuntimeSettingsForConfig().permissions.egress.denylist,
    llmAdapters: defaultLlmAdapters,
  });
  registerMemoryLlmClient(memoryLlmClient);
  const mcpDnsValidationCache = new RemoteMcpDnsValidationCache();
  let credentialBrokerPromise:
    | Promise<AgentCredentialBroker | undefined>
    | undefined;
  let credentialBrokerConfigKey = '';
  const credentialBindingPromises = new Map<string, Promise<void>>();
  const ops = () => options.opsRepository ?? getRuntimeRepositories();
  const channelRuntime = createMutableChannelRuntime();
  const resolveExecutionProviderId = (
    route: Pick<ConversationRoute, 'agentConfig' | 'folder'>,
    chatJid: string,
  ) =>
    resolveGroupRouteExecutionProviderId({
      group: route,
      appId: appIdFromConversationJid(chatJid) ?? 'default',
      defaultModel: getDefaultModelConfig('interactive', route.folder).model,
      executionAdapter,
      agentHarness: getSelectedAgentHarness(route.folder),
      listConfiguredProviders: getConfiguredModelProvidersForApp,
      familyOrder: getRuntimeSettingsForConfig().modelFamilies,
    });
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
      limits: () => getRuntimeSettingsForConfig().limits,
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
    const [agentTs, loadedRoutes] = await Promise.all([
      repository.getRouterState('last_agent_timestamp'),
      repository.getAllConversationRoutes(),
    ]);
    try {
      lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      lastAgentTimestamp = {};
    }
    conversationRoutes = loadedRoutes;
    const seededCount = await ensureRouteProfileDefaults(
      Object.values(conversationRoutes),
      { getFileArtifactStore: () => getRuntimeStorage().fileArtifacts },
    );
    if (seededCount > 0) {
      logger.debug(
        { seededCount },
        'Profile defaults seeded for persisted routes',
      );
    }
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
        const agentTimestampJson = JSON.stringify(lastAgentTimestamp);
        await ops().setRouterState('last_agent_timestamp', agentTimestampJson);
      } while (stateSaveDirty);
    })().finally(() => {
      stateSaveInFlight = undefined;
    });

    return stateSaveInFlight;
  }

  async function getOrRecoverCursor(chatJid: string): Promise<string> {
    const existing = lastAgentTimestamp[chatJid];
    if (existing) return existing;
    const parsed = parseAgentThreadQueueKey(chatJid);
    const providerScopedBaseKey = parsed.providerAccountId
      ? makeAgentThreadQueueKey(
          parsed.chatJid,
          undefined,
          parsed.threadId,
          parsed.providerAccountId,
        )
      : undefined;
    if (parsed.threadId) {
      const baseExisting =
        (providerScopedBaseKey && lastAgentTimestamp[providerScopedBaseKey]) ||
        (!parsed.providerAccountId &&
          lastAgentTimestamp[
            makeThreadQueueKey(parsed.chatJid, parsed.threadId)
          ]);
      return baseExisting ? (lastAgentTimestamp[chatJid] = baseExisting) : '';
    }
    const baseExisting =
      parsed.agentId &&
      (providerScopedBaseKey
        ? lastAgentTimestamp[providerScopedBaseKey]
        : lastAgentTimestamp[parsed.chatJid]);
    if (baseExisting) return (lastAgentTimestamp[chatJid] = baseExisting);

    const baseChatJid = parsed.chatJid;
    const botCursor = await ops().getLastBotMessageCursor(baseChatJid, {
      providerAccountId: parsed.providerAccountId,
    });
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
    const routeKey = makeAgentThreadQueueKey(
      jid,
      agentIdForFolder(group.folder),
      undefined,
      group.providerAccountId,
    );
    await registerGroupEntry(conversationRoutes, routeKey, group, {
      assistantName: ASSISTANT_NAME,
      persist: async () => undefined,
      ensureCredentialBinding,
      getFileArtifactStore: () => getRuntimeStorage().fileArtifacts,
    });
  }

  async function unregisterConversationRoute(jid: string): Promise<void> {
    const routeKeys = conversationRouteKeysForRemoval(conversationRoutes, jid);
    for (const routeKey of routeKeys) {
      delete conversationRoutes[routeKey];
      queue.stopGroup(routeKey);
      await ops().deleteConversationRoute(routeKey);
    }
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
  const setGroupPermissionModeOverride: GroupProcessingDeps['setGroupPermissionModeOverride'] =
    async (chatJid, permissionMode) =>
      setGroupPermissionModeOverrideEntry(
        conversationRoutes,
        chatJid,
        permissionMode,
        (jid, group) => ops().setConversationRoute(jid, group),
      );
  async function getAvailableGroups(): Promise<AvailableGroup[]> {
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
    metadata: { memoryUserId?: string; providerAccountId?: string | null } = {},
  ): Promise<void> {
    const {
      chatJid: conversationJid,
      agentId,
      providerAccountId: routeProviderAccountId,
    } = parseAgentThreadQueueKey(chatJid);
    const providerAccountId =
      routeProviderAccountId ?? metadata.providerAccountId;
    const group = resolveConversationRoute(
      conversationRoutes,
      conversationJid,
      threadId,
      agentId,
      providerAccountId,
    );
    if (!group) return;
    await ops().deleteSession(group.folder, threadId, {
      conversationJid,
      providerAccountId,
      conversationKind: group.conversationKind,
      memoryUserId: metadata.memoryUserId,
    });
  }

  const groupProcessor = createGroupProcessor({
    channelRuntime: channelRuntime.proxy,
    getConversationRoutes: () => conversationRoutes,
    getGroup: (chatJid, threadId, agentId, providerAccountId) =>
      resolveConversationRoute(
        conversationRoutes,
        chatJid,
        threadId,
        agentId,
        providerAccountId,
      ),
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
    setGroupPermissionModeOverride,
    getAvailableGroups,
    getRegisteredJids: () => new Set(Object.keys(conversationRoutes)),
    opsRepository: options.opsRepository,
    getRuntimeRepository: ops,
    queue: {
      enqueueMessageCheck: (chatJid) => queue.enqueueMessageCheck(chatJid),
      closeStdin: (chatJid) => queue.closeStdin(chatJid),
      notifyIdle: (chatJid) => queue.notifyIdle(chatJid),
      stopGroup: (chatJid) => queue.stopGroup(chatJid),
      isShuttingDown: () => queue.isShuttingDown(),
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
    getAsyncTaskRepository: () => getRuntimeStorage().repositories.asyncTasks,
    getPatternCandidateRepository: () =>
      getRuntimeStorage().repositories.patternCandidates,
    getProactiveSurfacingRepository: () =>
      getRuntimeStorage().repositories.proactiveSurfacing,
    getAgentLockStatus: resolveAgentLockStatus,
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
    normalizeProviderId: (providerId) =>
      normalizeProviderId?.(providerId) ?? providerId.trim().toLowerCase(),
    resolvePersonIdentity: resolveRuntimePersonIdentity,
    publishRuntimeEvent: options.publishRuntimeEvent,
    executionAdapter,
    executionAdapters,
    runnerSandboxProvider,
    getConfiguredModelProviders: getConfiguredModelProvidersForApp,
    getModelFamilyOrder: () => getRuntimeSettingsForConfig().modelFamilies,
    getDefaultInteractiveModel: (agentFolder) =>
      getDefaultModelConfig('interactive', agentFolder).model,
    getSelectedAgentHarness,
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
    setGroupPermissionModeOverride,
    getAvailableGroups,
    setConversationRoutesForTest,
    ensureCredentialBindingsForConversationRoutes,
    getCredentialBroker,
    clearSessionForChatJid,
    processGroupMessages: (chatJid, options) =>
      groupProcessor.processGroupMessages(chatJid, options),
    getConversationRoutes: () => conversationRoutes,
    resolveExecutionProviderId,
    setAgentCursor: (chatJid, timestamp) => {
      lastAgentTimestamp[chatJid] = timestamp;
    },
    setChannelRuntime: (runtime) => {
      channelRuntime.set(runtime);
    },
    setProviderIdNormalizer: (normalize) =>
      void (normalizeProviderId = normalize),
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
  if (!defaultRuntimeApp) defaultRuntimeApp = createRuntimeApp(options);
  return defaultRuntimeApp;
}

export function getAvailableGroups(): Promise<AvailableGroup[]> {
  return getDefaultRuntimeApp().getAvailableGroups();
}

/** @internal - exported for testing */
export function _setConversationRoutes(
  groups: Record<string, ConversationRoute>,
): void {
  getDefaultRuntimeApp().setConversationRoutesForTest(groups);
}
