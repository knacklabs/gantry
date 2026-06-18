import type { ChildProcess } from 'child_process';

import type {
  MessageSendOptions,
  AdaptiveCardPayload,
  AdaptiveCardSendOptions,
  MessageDeliveryResult,
  ProgressUpdateOptions,
  ConversationRoute,
  StreamingChunkOptions,
  ThinkingOverride,
} from '../domain/types.js';
import type {
  RuntimeAgentSessionRepository,
  RuntimeMessageRepository,
} from '../domain/repositories/ops-repo.js';
import type { AvailableGroup, spawnAgent } from './agent-spawn.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import type { SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../domain/ports/repositories.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import type { RemoteMcpDnsValidationCache } from '../application/mcp/mcp-server-policy.js';
import type { SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { RunnerSandboxProvider } from '../shared/runner-sandbox-provider.js';
import type { FamilyOrderOverrides } from '../shared/model-families.js';

export type GroupProcessingRepository = RuntimeAgentSessionRepository &
  RuntimeMessageRepository;

export interface GroupProcessor {
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
}

export interface GroupProcessingDeps {
  channelRuntime: {
    hasChannel: (chatJid: string) => boolean;
    supportsStreaming: (chatJid: string) => boolean;
    supportsProgress: (chatJid: string) => boolean;
    sendMessage: (
      chatJid: string,
      rawText: string,
      options?: MessageSendOptions,
    ) => Promise<void>;
    sendAdaptiveCard?: (
      chatJid: string,
      card: AdaptiveCardPayload,
      options?: AdaptiveCardSendOptions,
    ) => Promise<MessageDeliveryResult | undefined>;
    sendStreamingChunk: (
      chatJid: string,
      rawText: string,
      options?: StreamingChunkOptions,
    ) => Promise<boolean>;
    resetStreaming: (chatJid: string) => void;
    setTyping: (chatJid: string, isTyping: boolean) => Promise<void>;
    sendProgressUpdate: (
      chatJid: string,
      text: string,
      options?: ProgressUpdateOptions,
    ) => Promise<void>;
    isControlApproverAllowed?: (input: {
      conversationJid: string;
      userId: string;
      sourceAgentFolder: string;
      decisionPolicy?: 'same_channel';
    }) => Promise<boolean>;
  };
  getGroup: (chatJid: string) => ConversationRoute | undefined;
  clearSession: (
    workspaceFolder: string,
    threadId?: string | null,
    metadata?: {
      conversationJid?: string;
      conversationKind?: 'dm' | 'channel';
      memoryUserId?: string;
    },
  ) => Promise<void> | void;
  getCursor: (chatJid: string) => Promise<string> | string;
  setCursor: (chatJid: string, timestamp: string) => void;
  saveState: () => Promise<void> | void;
  setGroupModelOverride: (
    chatJid: string,
    model: string | undefined,
  ) => Promise<void> | void;
  setGroupThinkingOverride: (
    chatJid: string,
    thinking: ThinkingOverride | undefined,
  ) => Promise<void> | void;
  getAvailableGroups: () => Promise<AvailableGroup[]> | AvailableGroup[];
  getRegisteredJids: () => Set<string>;
  queue: {
    closeStdin: (chatJid: string) => void;
    notifyIdle: (chatJid: string) => void;
    stopGroup?: (chatJid: string) => boolean;
    isShuttingDown?: () => boolean;
    registerProcess: (
      groupJid: string,
      proc: ChildProcess,
      runHandle: string,
      workspaceFolder?: string,
      stopAliasJids?: string | string[],
      threadId?: string | null,
      options?: { requiredContinuationUserId?: string | null },
    ) => void;
    registerContinuationHandler?: (
      groupJid: string,
      handler: () => void,
    ) => () => void;
  };
  runAgent?: typeof spawnAgent;
  getCredentialBroker?: () => Promise<AgentCredentialBroker | undefined>;
  getToolRepository?: () => ToolCatalogRepository | undefined;
  getSkillRepository?: () => SkillCatalogRepository | undefined;
  getMcpServerRepository?: () => McpServerRepository | undefined;
  getCapabilitySecretRepository?: () => CapabilitySecretRepository | undefined;
  getMcpHostnameLookup?: () => HostnameLookup | undefined;
  getMcpDnsValidationCache?: () => RemoteMcpDnsValidationCache | undefined;
  getSkillArtifactStore?: () => SkillArtifactStore | undefined;
  collectSessionMemory?: SessionMemoryCollector;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<void> | void;
  executionAdapter?: AgentExecutionAdapter;
  executionAdapters?: AgentExecutionAdapterRegistry;
  runnerSandboxProvider: RunnerSandboxProvider;
  // Configured Model Access providers for the app, used by live model-family
  // failover to build the ordered candidate list. Optional: when absent (e.g. an
  // injected test runner) failover degrades to a single candidate.
  getConfiguredModelProviders?: (appId: string) => Promise<Set<string>>;
  getModelFamilyOrder?: () => FamilyOrderOverrides | undefined;
  opsRepository?: GroupProcessingRepository;
  getRuntimeRepository?: () => GroupProcessingRepository;
}
