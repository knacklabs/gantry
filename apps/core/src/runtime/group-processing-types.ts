import type { ChildProcess } from 'child_process';

import type {
  MessageSendOptions,
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
import type { GuardrailClassifier } from '../application/guardrails/types.js';
import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { ToolCallRecord } from './reply-trace.js';
import type { MessageTraceRow } from '../adapters/storage/postgres/repositories/message-trace-repository.postgres.js';

export type GroupProcessingRepository = RuntimeAgentSessionRepository &
  RuntimeMessageRepository;

/**
 * Per-reply latency-trace port (generic, best-effort). Drains the MCP-call
 * records collected for a run and persists the assembled trace. Every method
 * must be safe to call without ever throwing into the reply path.
 */
export interface ReplyTracePort {
  /** Drain collected MCP-call records for a run handle (empty if none). */
  drain: (runHandle: string) => ToolCallRecord[];
  /** Persist an assembled trace row (swallows its own errors). */
  saveTrace: (row: MessageTraceRow) => Promise<void>;
  /** Whether full payloads should be captured (GANTRY_TRACE_PAYLOADS=1). */
  payloadsEnabled: () => boolean;
}

export interface GroupProcessor {
  processGroupMessages: (
    chatJid: string,
    options?: { queued?: boolean },
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
    groupFolder: string,
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
    registerProcess: (
      groupJid: string,
      proc: ChildProcess,
      runHandle: string,
      groupFolder?: string,
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
  guardrailClassifier?: GuardrailClassifier;
  executionAdapter?: AgentExecutionAdapter;
  executionAdapters?: AgentExecutionAdapterRegistry;
  opsRepository?: GroupProcessingRepository;
  getRuntimeRepository?: () => GroupProcessingRepository;
  /** Per-reply latency trace (best-effort; absent in tests that don't trace). */
  replyTrace?: ReplyTracePort;
}
