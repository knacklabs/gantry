import type { ChildProcess } from 'child_process';

import type {
  MessageSendOptions,
  ProgressUpdateOptions,
  ConversationRoute,
  StreamingChunkOptions,
  ThinkingOverride,
} from '../domain/types.js';
import type {
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
} from '../domain/ports/conversation-context-hydration.js';
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
import type { AgentHarness } from '../shared/agent-engine.js';
import type { PermissionMode } from '../shared/permission-mode.js';
import type { AsyncTaskRepository } from '../domain/ports/async-tasks.js';
import type { PatternCandidateRepository } from '../domain/ports/pattern-candidates.js';
import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import type { AgentLockStatus } from './proactive-surfacing-gate.js';
import type { GroupAgentRunResult } from './group-agent-runner.js';

export type {
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
};

export type GroupProcessingRepository = RuntimeAgentSessionRepository &
  RuntimeMessageRepository;

export type GroupProcessOptions = {
  queued?: boolean;
  memoryContext?: {
    userId?: string;
    source?: 'message' | 'command';
    threadId?: string | null;
    recallQuery?: string;
  };
  existingRunId?: string;
  existingRunLeaseToken?: string;
  existingRunLeaseWorkerInstanceId?: string;
  existingRunLeaseFencingVersion?: number;
  finalRetry?: boolean;
  onRunResult?: (result: GroupAgentRunResult) => void;
  onFirstProgress?: (input: {
    jid: string;
    messageRef: string;
  }) => Promise<void> | void;
  onLiveStopActionToken?: (token: string) => Promise<void> | void;
};

export interface GroupProcessor {
  processGroupMessages: (
    chatJid: string,
    options?: GroupProcessOptions,
  ) => Promise<boolean>;
}

export interface ProactiveSurfacingConsentReader {
  getBySubject(subject: {
    appId: string;
    agentId: string;
    subjectType: string;
    subjectId: string;
  }): Promise<{ proactiveSurfacingEnabled: boolean } | null>;
}

export interface GroupProcessingDeps {
  channelRuntime: {
    hasChannel: (
      chatJid: string,
      options?: { providerAccountId?: string },
    ) => boolean;
    supportsStreaming: (
      chatJid: string,
      options?: { providerAccountId?: string },
    ) => boolean;
    supportsProgress: (
      chatJid: string,
      options?: { providerAccountId?: string },
    ) => boolean;
    sendMessage: (
      chatJid: string,
      rawText: string,
      options?: MessageSendOptions,
    ) => Promise<void>;
    sendStreamingChunk: (
      chatJid: string,
      rawText: string,
      options?: StreamingChunkOptions,
    ) => Promise<boolean>;
    resetStreaming: (
      chatJid: string,
      options?: { providerAccountId?: string },
    ) => void;
    setTyping: (
      chatJid: string,
      isTyping: boolean,
      options?: { providerAccountId?: string },
    ) => Promise<void>;
    sendProgressUpdate: (
      chatJid: string,
      text: string,
      options?: ProgressUpdateOptions,
    ) => Promise<void>;
    renderAgentTodo?: (
      chatJid: string,
      render: AgentTodoRender,
      options?: { providerAccountId?: string },
    ) => Promise<boolean>;
    hydrateConversationContext?: (
      request: ConversationContextHydrationRequest,
    ) => Promise<ConversationContextHydrationResult>;
    isControlApproverAllowed?: (input: {
      conversationJid: string;
      userId: string;
      sourceAgentFolder: string;
      decisionPolicy?: 'same_channel';
    }) => Promise<boolean>;
  };
  getGroup: (
    chatJid: string,
    threadId?: string | null,
    agentId?: string | null,
    providerAccountId?: string | null,
  ) => ConversationRoute | undefined;
  getConversationRoutes?: () => Record<string, ConversationRoute>;
  clearSession: (
    workspaceFolder: string,
    threadId?: string | null,
    metadata?: {
      appId?: string;
      conversationJid?: string;
      providerAccountId?: string | null;
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
  setGroupPermissionModeOverride: (
    chatJid: string,
    permissionMode: PermissionMode | undefined,
  ) => Promise<void> | void;
  getAvailableGroups: () => Promise<AvailableGroup[]> | AvailableGroup[];
  getRegisteredJids: () => Set<string>;
  queue: {
    enqueueMessageCheck: (chatJid: string) => boolean | void;
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
  getAsyncTaskRepository?: () => AsyncTaskRepository | undefined;
  getPatternCandidateRepository?: () => PatternCandidateRepository | undefined;
  getProactiveSurfacingRepository?: () =>
    ProactiveSurfacingConsentReader | undefined;
  getAgentLockStatus?: (sourceAgentFolder: string) => AgentLockStatus;
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
  getDefaultInteractiveModel?: (agentFolder?: string) => string | undefined;
  getSelectedAgentHarness: (agentFolder?: string) => AgentHarness;
  opsRepository?: GroupProcessingRepository;
  getRuntimeRepository?: () => GroupProcessingRepository;
}
