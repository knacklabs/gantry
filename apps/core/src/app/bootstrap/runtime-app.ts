import { hostname as getHostname } from 'node:os';

import {
  ASSISTANT_NAME,
  getCredentialBrokerRuntimeConfig,
  getRuntimeQueueConfig,
  getRuntimeWarmPoolConfig,
} from '../../config/index.js';
import {
  createAgentCredentialBroker,
  ensureAgentCredentialBinding,
  ensureModelCredentialBinding,
} from '../../adapters/credentials/agent-credential-broker-factory.js';
import { createGuardrailClassifier } from '../../application/guardrails/guardrail-classifier.js';
import {
  MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
  MODEL_RUNTIME_CREDENTIAL_NAME,
} from '../../domain/models/credentials.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import {
  decodeGroupMessageCursor,
  encodeGroupMessageCursor,
} from '../../shared/message-cursor.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  ConversationRoute,
  MessageSendOwnershipToken,
  ThinkingOverride,
} from '../../domain/types.js';
import type {
  RuntimeConfiguredAgent,
  RuntimeProviderSettings,
} from '../../config/settings/runtime-settings-types.js';
import { RemoteMcpDnsValidationCache } from '../../application/mcp/mcp-server-policy.js';
import { createGroupProcessor } from '../../runtime/group-processing.js';
import type { GroupProcessingDeps } from '../../runtime/group-processing-types.js';
import {
  memoryScopeForConversationKind,
  resolveTurnSemanticCapabilities,
  resolveTurnSelectedMcpServerIds,
  resolveTurnSelectedSkillContext,
  resolveTurnToolPolicy,
} from '../../runtime/group-run-context.js';
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
import { memoryAgentIdForGroupFolder } from '../../memory/app-memory-boundaries.js';
import {
  createDefaultAgentExecutionAdapterRegistry,
  createDefaultMemoryLlmClient,
} from '../../adapters/llm/default-runtime-adapters.js';
import type { AgentExecutionAdapter } from '../../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../../application/agent-execution/agent-execution-adapter-registry.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import { hasWarmPoolCapability } from '../../application/agent-execution/warm-pool-capable.js';
import { registerMemoryLlmClient } from '../../memory/memory-llm-port.js';
import { runClaudeQuery } from '../../adapters/llm/anthropic-claude-agent/memory-query.js';
import { WarmPoolManager } from '../../runtime/warm-pool-manager.js';
import { ProcessWarmPoolOrphanReaper } from '../../runtime/warm-pool-orphan-reaper.js';
import type { WarmPoolRuntime } from '../../runtime/agent-spawn-types.js';
import type {
  WorkerInventorySnapshot,
  WorkerInventoryWarmPoolSnapshot,
} from '../../runtime/worker-inventory-snapshot.js';
import { spawnAgent } from '../../runtime/agent-spawn.js';
import { promptProfileAgentIdForFolder } from '../../application/agents/prompt-profile-service.js';
import { defaultModelStatusSelection } from '../../session/session-model-status.js';
import { resolveRuntimeExecutionProviderId } from '../../runtime/execution-provider-id.js';

export type RuntimeAppRepository = RuntimeRouterStateRepository &
  RuntimeMessageRepository &
  RuntimeConversationRouteRepository &
  RuntimeChatMetadataRepository &
  RuntimeAgentSessionRepository;

export interface RuntimeApp {
  executionAdapter: AgentExecutionAdapter;
  executionAdapters: AgentExecutionAdapterRegistry;
  warmPool?: WarmPoolRuntime;
  queue: GroupQueue;
  // The guardrail classifier used on the agent-spawn path. Exposed so the
  // message loop can apply the same guardrail to the continuation path.
  guardrailClassifier: GroupProcessingDeps['guardrailClassifier'];
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
    options?: { queued?: boolean },
  ) => Promise<boolean>;
  getMessageSendOwnershipToken: (input: {
    conversationId: string;
    threadId?: string | null;
  }) => Promise<MessageSendOwnershipToken | undefined>;
  prewarmAgentForConversationRoute: (chatJid: string) => Promise<boolean>;
  getWorkerInventorySnapshot: (now?: Date) => WorkerInventorySnapshot;
  getConversationRoutes: () => Record<string, ConversationRoute>;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  setAgentCursor: (chatJid: string, timestamp: string) => void;
  setChannelRuntime: (runtime: GroupProcessingDeps['channelRuntime']) => void;
  // Provider settings (e.g. providers.interakt.default_agent). Populated at
  // startup from parsed settings.yaml so the routing layer can consult per-
  // provider config without an additional load.
  setProviderSettings: (
    providers: Record<string, RuntimeProviderSettings>,
  ) => void;
  getProviderSettings: (
    providerId: string,
  ) => RuntimeProviderSettings | undefined;
  // Configured agents from settings.yaml's agents: block, indexed by folder.
  // Used by the routing layer to project virtual routes for a provider's
  // default_agent (we need the agent's display name + folder).
  setAgentsSettings: (agents: Record<string, RuntimeConfiguredAgent>) => void;
  getAgentSettings: (folder: string) => RuntimeConfiguredAgent | undefined;
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
  guardrailClassifier?: GroupProcessingDeps['guardrailClassifier'];
  executionAdapter?: AgentExecutionAdapter;
  executionAdapters?: AgentExecutionAdapterRegistry;
  warmPool?: WarmPoolRuntime;
  runtimeInstanceId?: string;
  runtimeHostname?: string;
  runtimeStartedAt?: Date;
  opsRepository?: RuntimeAppRepository;
  getMessageSendOwnershipToken?: GroupProcessingDeps['getMessageSendOwnershipToken'];
  claimConversationWork?: GroupProcessingDeps['claimConversationWork'];
  onMessageRunStart?: (groupJid: string) => (() => void) | void;
  /** Per-reply latency trace (best-effort). Injected at boot; absent in tests. */
  replyTrace?: GroupProcessingDeps['replyTrace'];
}

function createConfiguredWarmPool(
  executionAdapter: AgentExecutionAdapter,
): WarmPoolRuntime | undefined {
  const config = getRuntimeWarmPoolConfig();
  if (!config.enabled || !hasWarmPoolCapability(executionAdapter)) {
    return undefined;
  }
  return new WarmPoolManager({
    capability: executionAdapter,
    maxConcurrentPrewarm: Math.max(1, config.size),
    maxBoundWorkers: config.maxBoundWorkers,
    cachePrewarmEnabled: config.cachePrewarmEnabled,
    maxConcurrentCachePrewarm: config.cachePrewarmConcurrency,
    orphanReaper: new ProcessWarmPoolOrphanReaper(),
  });
}

const EMPTY_WORKER_WARM_POOL_SNAPSHOT: WorkerInventoryWarmPoolSnapshot = {
  availableTarget: 0,
  genericAvailable: 0,
  genericStarting: 0,
  boundActive: 0,
  boundIdle: 0,
  boundDraining: 0,
  maxBoundWorkers: 0,
  cachePrewarm: {
    pending: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
  },
  cacheShapes: [],
};

function parseAgentTimestampState(
  raw: string | undefined,
): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function cursorTimeValue(timestamp: string): number | undefined {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compareAgentCursors(left: string, right: string): number {
  const leftCursor = decodeGroupMessageCursor(left);
  const rightCursor = decodeGroupMessageCursor(right);
  const leftTime = cursorTimeValue(leftCursor.timestamp);
  const rightTime = cursorTimeValue(rightCursor.timestamp);
  if (leftTime !== undefined && rightTime !== undefined) {
    if (leftTime !== rightTime) return leftTime - rightTime;
  } else if (leftCursor.timestamp !== rightCursor.timestamp) {
    return leftCursor.timestamp.localeCompare(rightCursor.timestamp);
  }
  return leftCursor.id.localeCompare(rightCursor.id);
}

function mergeAgentTimestampState(
  durable: Record<string, string>,
  local: Record<string, string>,
): Record<string, string> {
  const merged = { ...durable };
  for (const [key, localCursor] of Object.entries(local)) {
    const durableCursor = merged[key];
    if (!durableCursor || compareAgentCursors(localCursor, durableCursor) > 0) {
      merged[key] = localCursor;
    }
  }
  return merged;
}

export function createRuntimeApp(options: RuntimeAppOptions = {}): RuntimeApp {
  let lastTimestamp = '';
  let conversationRoutes: Record<string, ConversationRoute> = {};
  let lastAgentTimestamp: Record<string, string> = {};
  let stateSaveInFlight: Promise<void> | undefined;
  let stateSaveDirty = false;
  let providerSettingsByProvider: Record<string, RuntimeProviderSettings> = {};
  let agentSettingsByFolder: Record<string, RuntimeConfiguredAgent> = {};

  const queue =
    options.queue ??
    new GroupQueue({
      ...getRuntimeQueueConfig(),
      onMessageRunStart: options.onMessageRunStart,
    });
  // Single guardrail classifier instance shared by both the spawn path
  // (group processor) and the continuation path (message loop), so the
  // guardrail behaves identically regardless of which path a message takes.
  const guardrailClassifier =
    options.guardrailClassifier ??
    createGuardrailClassifier({
      query: (input) =>
        runClaudeQuery({
          appId: 'default' as never,
          ...input,
        }),
    });
  const executionAdapters =
    options.executionAdapters ?? createDefaultAgentExecutionAdapterRegistry();
  const executionAdapter =
    options.executionAdapter ?? executionAdapters.list()[0];
  if (!executionAdapter) {
    throw new Error('Runtime requires at least one model execution adapter.');
  }
  const warmPool =
    options.warmPool ?? createConfiguredWarmPool(executionAdapter);
  const runtimeInstanceId =
    options.runtimeInstanceId ?? `runtime:${process.pid}`;
  const runtimeHostname = options.runtimeHostname ?? getHostname();
  const runtimeStartedAt = (
    options.runtimeStartedAt ?? new Date()
  ).toISOString();
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
      identifier: memoryAgentIdForGroupFolder(group.folder),
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
    lastAgentTimestamp = parseAgentTimestampState(agentTs);
    if (agentTs && Object.keys(lastAgentTimestamp).length === 0) {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
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
        const durableAgentTimestamp = parseAgentTimestampState(
          await ops().getRouterState('last_agent_timestamp'),
        );
        lastAgentTimestamp = mergeAgentTimestampState(
          durableAgentTimestamp,
          lastAgentTimestamp,
        );
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

  async function refreshAgentTimestampState(): Promise<void> {
    const durableAgentTimestamp = parseAgentTimestampState(
      await ops().getRouterState('last_agent_timestamp'),
    );
    lastAgentTimestamp = mergeAgentTimestampState(
      durableAgentTimestamp,
      lastAgentTimestamp,
    );
  }

  async function getOrRecoverCursor(chatJid: string): Promise<string> {
    await refreshAgentTimestampState();
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
        identifier: memoryAgentIdForGroupFolder(group.folder),
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
    clearSession: async (groupFolder, threadId, metadata) => {
      await ops().deleteSession(groupFolder, threadId, metadata);
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
    getMessageSendOwnershipToken: options.getMessageSendOwnershipToken,
    claimConversationWork: options.claimConversationWork,
    replyTrace: options.replyTrace,
    queue: {
      closeStdin: (chatJid) => queue.closeStdin(chatJid),
      notifyIdle: (chatJid) => queue.notifyIdle(chatJid),
      sendMessage: (chatJid, text, sendOptions) =>
        queue.sendMessage(chatJid, text, sendOptions),
      stopGroup: (chatJid) => queue.stopGroup(chatJid),
      registerProcess: (
        groupJid,
        proc,
        runHandle,
        groupFolder,
        stopAliasJids,
        threadId,
        registerOptions,
      ) =>
        queue.registerProcess(
          groupJid,
          proc,
          runHandle,
          groupFolder,
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
    guardrailClassifier,
    executionAdapter,
    executionAdapters,
    warmPool,
  });

  async function prewarmAgentForConversationRoute(
    chatJid: string,
  ): Promise<boolean> {
    const warmPoolConfig = getRuntimeWarmPoolConfig();
    if (!warmPoolConfig.enabled || !warmPool) return false;
    const group = conversationRoutes[chatJid];
    if (!group) return false;

    const appId = 'default';
    const agentId = promptProfileAgentIdForFolder(group.folder);
    const turnContext = { appId, agentId };
    const storage = getRuntimeStorage();
    const initialModelSelection = defaultModelStatusSelection(
      group.agentConfig?.model ?? 'opus',
    );
    const executionProviderId = (initialModelSelection.model
      ?.executionProviderId ??
      resolveRuntimeExecutionProviderId(
        executionAdapter,
      )) as ExecutionProviderId;
    const sessionContext = await storage.ops.getAgentTurnContext?.({
      agentFolder: group.folder,
      executionProviderId,
      conversationJid: chatJid,
      conversationKind: group.conversationKind,
      hydrateMemory: false,
    });
    const deps = {
      getToolRepository: () => storage.repositories.tools,
      getSkillRepository: () => storage.repositories.skills,
      getMcpServerRepository: () => storage.repositories.mcpServers,
    };
    const [configuredToolPolicy, selectedSkillContext, semanticCapabilities] =
      await Promise.all([
        resolveTurnToolPolicy(deps, turnContext),
        resolveTurnSelectedSkillContext(deps, turnContext),
        resolveTurnSemanticCapabilities(deps, turnContext),
      ]);
    const attachedMcpSourceIds = await resolveTurnSelectedMcpServerIds(
      deps,
      turnContext,
      configuredToolPolicy.allowedTools,
    );
    const credentialBroker = await getCredentialBroker();
    const output = await spawnAgent(
      group,
      {
        prompt: '',
        appId,
        agentId,
        chatJid,
        groupFolder: group.folder,
        memoryDefaultScope: memoryScopeForConversationKind(
          group.conversationKind,
        ),
        persona: group.agentConfig?.persona,
        promptSurface: group.agentConfig?.promptSurface,
        allowedTools: configuredToolPolicy.allowedTools,
        gantryMcpToolSurface: group.agentConfig?.toolSurface?.gantryMcp,
        nativeToolSurface: group.agentConfig?.toolSurface?.native,
        runtimeAccess: configuredToolPolicy.runtimeAccess,
        attachedSkillSourceIds: selectedSkillContext.ids,
        selectedSkillDisplays: selectedSkillContext.displays,
        attachedMcpSourceIds,
        semanticCapabilities,
        assistantName: group.trigger || ASSISTANT_NAME,
        thinking: group.agentConfig?.thinking,
        ...(sessionContext?.externalSessionId
          ? { sessionId: sessionContext.externalSessionId }
          : {}),
      },
      () => {},
      undefined,
      {
        ...(credentialBroker ? { credentialBroker } : {}),
        skillRepository: storage.repositories.skills,
        skillArtifactStore: getRuntimeSkillArtifactStore(),
        skillContext: turnContext,
        mcpServerRepository: storage.repositories.mcpServers,
        capabilitySecretRepository: storage.repositories.capabilitySecrets,
        mcpContext: turnContext,
        mcpHostnameLookup: options.mcpHostnameLookup?.(),
        mcpDnsValidationCache,
        ...(options.publishRuntimeEvent
          ? { publishRuntimeEvent: options.publishRuntimeEvent }
          : {}),
        executionAdapter,
        executionAdapters,
        warmPool,
        warmPoolPrewarmOnly: true,
      },
    );
    if (output.status === 'error') {
      logger.warn(
        { group: group.name, error: output.error },
        'Warm-pool startup prewarm failed',
      );
      return false;
    }
    logger.info(
      { group: group.name, chatJid },
      'Warm-pool route prewarm ready',
    );
    return true;
  }

  function getWorkerInventorySnapshot(
    now: Date = new Date(),
  ): WorkerInventorySnapshot {
    return {
      instanceId: runtimeInstanceId,
      hostname: runtimeHostname,
      startedAt: runtimeStartedAt,
      lastHeartbeatAt: now.toISOString(),
      warmPool: warmPool?.inventory?.() ?? {
        ...EMPTY_WORKER_WARM_POOL_SNAPSHOT,
      },
      queue: queue.getWorkerInventorySnapshot(),
    };
  }

  return {
    executionAdapter,
    executionAdapters,
    ...(warmPool ? { warmPool } : {}),
    queue,
    guardrailClassifier,
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
    getMessageSendOwnershipToken: async (input) =>
      options.getMessageSendOwnershipToken?.(input),
    prewarmAgentForConversationRoute,
    getWorkerInventorySnapshot,
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
    setProviderSettings: (providers) => {
      providerSettingsByProvider = providers;
    },
    getProviderSettings: (providerId) => providerSettingsByProvider[providerId],
    setAgentsSettings: (agents) => {
      agentSettingsByFolder = agents;
    },
    getAgentSettings: (folder) => agentSettingsByFolder[folder],
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
