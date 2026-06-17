import type {
  RuntimeMemorySettingsSnapshot,
  RuntimeStorageSettingsSnapshot,
} from './memory-snapshot.js';
import type { AgentPersona } from '../../shared/agent-persona.js';
import type {
  AgentMemoryConfig,
  AgentPluginsConfig,
  AgentToolSurfaceConfig,
  GuardrailConfig,
  ThinkingOverride,
} from '../../domain/types.js';
import type { YoloModeSettings } from '../../shared/yolo-mode-policy.js';
import type { EgressSettings } from '../../shared/egress-policy.js';
import type {
  McpCredentialRef,
  McpServerRiskClass,
  McpServerTransportConfig,
} from '../../domain/mcp/mcp-servers.js';

export interface RuntimeProviderSettings {
  enabled: boolean;
  defaultConnection?: string;
  // Folder of the agent that should receive any inbound chat for this provider
  // that does not match a more-specific conversation route. When set, the
  // runtime projects a live virtual route on first inbound message without
  // persisting a per-customer route row.
  defaultAgent?: string;
}

export interface RuntimeProviderConnectionSettings {
  provider: string;
  label: string;
  runtimeSecretRefs: Record<string, string>;
}

export type RuntimeConversationKind =
  | 'dm'
  | 'direct'
  | 'group'
  | 'channel'
  | 'chat'
  | 'service'
  | 'web';

export interface RuntimeConfiguredConversation {
  providerConnection: string;
  externalId: string;
  kind: RuntimeConversationKind;
  displayName: string;
  senderPolicy: import('./sender-allowlist.js').ChatAllowlistEntry;
  controlApprovers: string[];
  // Marks this conversation as a clone source for inbound messages whose
  // external id does not have its own route. Used by the inbound-routing
  // layer (see channel-persistence-handlers.findInteraktDirectRouteTemplate).
  isTemplate?: boolean;
}

export interface RuntimeConfiguredMcpServer {
  name: string;
  displayName?: string;
  description?: string;
  riskClass: McpServerRiskClass;
  config: McpServerTransportConfig;
  allowedToolPatterns: string[];
  autoApproveToolPatterns: string[];
  credentialRefs: McpCredentialRef[];
  sandboxProfileId?: string;
}

export type EmbeddingProviderName = string;
export type MemoryModelTask = 'extractor' | 'dreaming' | 'consolidation';
export type MemoryBackfillMode = 'auto' | 'inline' | 'provider_batch';

export interface RuntimeMemoryLlmModels {
  extractor: string;
  dreaming: string;
  consolidation: string;
}

export interface RuntimeMemoryBackfillSettings {
  enabled: boolean;
  cron: string;
  maxItemsPerRun: number;
  mode: MemoryBackfillMode;
  providerBatchMinItems: number;
}

export interface RuntimeMemorySettings {
  enabled: boolean;
  embeddings: {
    enabled: boolean;
    provider: EmbeddingProviderName;
    model: string;
    dimensions: number;
    dailyLimit: number;
    batchSize: number;
    backfill: RuntimeMemoryBackfillSettings;
  };
  dreaming: {
    enabled: boolean;
    cron: string;
    embeddings: {
      enabled: boolean;
      provider: EmbeddingProviderName;
      model: string;
    };
  };
  llm: {
    models: RuntimeMemoryLlmModels;
    extractorMaxFacts: number;
    extractorMinConfidence: number;
  };
  maintenance: {
    maxPending: number;
  };
  // Idle-session memory sweep tuning. concurrency = how many of the per-pass batch
  // are extracted in parallel (background work shares the model rate budget with
  // live replies, so keep this low). extractionTimeoutMs = per-extraction deadline.
  idleSweepConcurrency: number;
  idleSweepExtractionTimeoutMs: number;
}

export interface RuntimeStorageSettings {
  postgres: {
    urlEnv: string;
    schema: string;
  };
}

export interface RuntimeAgentSettings {
  name: string;
  defaultModel: string;
  oneTimeJobDefaultModel: string;
  recurringJobDefaultModel: string;
  sessions: {
    memoryItemLimit: number;
    maxMemoryContextChars: number;
  };
}

export interface RuntimeConfiguredAgentBinding {
  jid: string;
  provider?: string;
  name?: string;
  trigger: string;
  addedAt: string;
  requiresTrigger: boolean;
  model?: string;
}

export interface RuntimeConfiguredBinding {
  agent: string;
  conversation: string;
  trigger: string;
  addedAt: string;
  requiresTrigger: boolean;
  memoryScope: 'conversation' | 'user' | 'agent';
  model?: string;
}

export interface RuntimeConfiguredAgentSourceRef {
  name?: string;
  id: string;
  version?: string;
  kind?: 'builtin' | 'skill' | 'mcp' | 'adapter' | 'local_cli';
}

export interface RuntimeConfiguredAgentSources {
  skills: RuntimeConfiguredAgentSourceRef[];
  mcpServers: RuntimeConfiguredAgentSourceRef[];
  tools: RuntimeConfiguredAgentSourceRef[];
}

export interface RuntimeConfiguredAgentCapability {
  id: string;
  version: string;
}

export type RuntimeConfiguredAgentGuardrail = GuardrailConfig;

export type RuntimeConfiguredAgentPlugins = AgentPluginsConfig;

export type RuntimeConfiguredAgentMemory = AgentMemoryConfig;

export type RuntimeConfiguredAgentToolSurface = AgentToolSurfaceConfig;

export interface RuntimeConfiguredAgent {
  name: string;
  folder: string;
  persona?: AgentPersona;
  model?: string;
  oneTimeJobDefaultModel?: string;
  recurringJobDefaultModel?: string;
  thinking?: ThinkingOverride;
  plugins?: RuntimeConfiguredAgentPlugins;
  memory?: RuntimeConfiguredAgentMemory;
  toolSurface?: RuntimeConfiguredAgentToolSurface;
  bindings: Record<string, RuntimeConfiguredAgentBinding>;
  sources: RuntimeConfiguredAgentSources;
  capabilities: RuntimeConfiguredAgentCapability[];
}

export interface RuntimeDesiredStateSettings {
  authoritative: boolean;
}

export type RuntimeCredentialBrokerMode = 'none' | 'gantry';

export interface RuntimeCredentialBrokerSettings {
  mode: RuntimeCredentialBrokerMode;
  gateway: {
    bindHost: string;
  };
}

export type { RuntimeMemorySettingsSnapshot, RuntimeStorageSettingsSnapshot };

export interface RuntimeQueueSettings {
  maxMessageRuns: number;
  maxJobRuns: number;
  maxRetries: number;
  baseRetryMs: number;
}

export interface RuntimeWarmPoolSettings {
  enabled: boolean;
  size: number;
  idleTtlMs: number;
  maxBoundWorkers: number;
  cachePrewarmEnabled: boolean;
  cachePrewarmConcurrency: number;
}

export interface RuntimeRunnerSettings {
  idleTimeoutMs: number;
}

export interface RuntimeOwnershipSettings {
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  reconcilerIntervalMs: number;
  reconcilerLimit: number;
  shutdownClaimWaitMs: number;
}

export interface RuntimeTraceSettings {
  payloadRetentionMs: number;
  payloadCleanupIntervalMs: number;
}

export interface RuntimeProcessSettings {
  queue: RuntimeQueueSettings;
  warmPool: RuntimeWarmPoolSettings;
  runner: RuntimeRunnerSettings;
  ownership: RuntimeOwnershipSettings;
  trace: RuntimeTraceSettings;
}

export type RuntimeBrowserUsagePolicyMode = 'audit' | 'enforce';

export interface RuntimeBrowserUsageOverride {
  mode?: RuntimeBrowserUsagePolicyMode;
  windowMs?: number;
  maxActionsPerWindow?: number;
  maxConcurrentPerSite?: number;
}

export interface RuntimeBrowserUsageSettings {
  enabled: boolean;
  mode: RuntimeBrowserUsagePolicyMode;
  windowMs: number;
  maxActionsPerWindow: number;
  maxConcurrentPerSite: number;
  overrides: Record<string, RuntimeBrowserUsageOverride>;
}

export interface RuntimeBrowserSettings {
  usage: RuntimeBrowserUsageSettings;
}

export interface RuntimePermissionSettings {
  yoloMode: YoloModeSettings;
  egress: EgressSettings;
}

export interface RuntimeSettings {
  desiredState: RuntimeDesiredStateSettings;
  providers: Record<string, RuntimeProviderSettings>;
  providerConnections: Record<string, RuntimeProviderConnectionSettings>;
  mcpServers: Record<string, RuntimeConfiguredMcpServer>;
  conversations: Record<string, RuntimeConfiguredConversation>;
  bindings: Record<string, RuntimeConfiguredBinding>;
  agents: Record<string, RuntimeConfiguredAgent>;
  storage: RuntimeStorageSettings;
  agent: RuntimeAgentSettings;
  credentialBroker: RuntimeCredentialBrokerSettings;
  memory: RuntimeMemorySettings;
  runtime: RuntimeProcessSettings;
  browser: RuntimeBrowserSettings;
  permissions: RuntimePermissionSettings;
}

export interface RuntimeSettingsValidationFailure {
  summary: string;
  details: string[];
}

export interface RuntimeSettingsValidationResult {
  ok: boolean;
  settings?: RuntimeSettings;
  failure?: RuntimeSettingsValidationFailure;
}
