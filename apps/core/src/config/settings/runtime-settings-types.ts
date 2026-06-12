import type {
  RuntimeMemorySettingsSnapshot,
  RuntimeStorageSettingsSnapshot,
} from './memory-snapshot.js';
import type { RuntimeDeploymentMode } from '../../shared/runtime-deployment-mode.js';
import type { AgentPersona } from '../../shared/agent-persona.js';
import type { AgentRelationshipMode } from '../../shared/agent-relationship-mode.js';
import type { YoloModeSettings } from '../../shared/yolo-mode-policy.js';
import type { EgressSettings } from '../../shared/egress-policy.js';

export interface RuntimeProviderSettings {
  enabled: boolean;
  defaultConnection?: string;
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
  // Per-agent MCP operation scope (subset of the server's reviewed tool
  // patterns). Only meaningful for `mcp_servers` source refs; empty/absent means
  // the agent inherits the server's full reviewed tool set.
  tools?: string[];
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

export type AgentAccessPreset = 'full' | 'locked';

export interface RuntimeConfiguredAgent {
  name: string;
  folder: string;
  persona?: AgentPersona;
  relationshipMode?: AgentRelationshipMode;
  model?: string;
  oneTimeJobDefaultModel?: string;
  recurringJobDefaultModel?: string;
  bindings: Record<string, RuntimeConfiguredAgentBinding>;
  sources: RuntimeConfiguredAgentSources;
  capabilities: RuntimeConfiguredAgentCapability[];
  accessPreset: AgentAccessPreset;
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
  maxMessageBacklog: number;
  maxTaskBacklog: number;
  maxRetries: number;
  baseRetryMs: number;
  drainDeadlineMs: number;
}

export interface RuntimeLiveTurnsSettings {
  enabled: boolean;
}

export type RuntimeSandboxProvider = 'direct' | 'sandbox_runtime';

export interface RuntimeSandboxSettings {
  provider: RuntimeSandboxProvider;
  resourceLimits: {
    cpuSeconds: number;
    memoryMb: number;
    maxProcesses: number;
  };
}

export type RuntimeArtifactStoreDriver = 'local' | 's3';

export interface RuntimeArtifactStoreSettings {
  driver: RuntimeArtifactStoreDriver;
  bucket?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export interface RuntimeProcessSettings {
  queue: RuntimeQueueSettings;
  liveTurns: RuntimeLiveTurnsSettings;
  sandbox: RuntimeSandboxSettings;
  artifactStore: RuntimeArtifactStoreSettings;
  deploymentMode: RuntimeDeploymentMode;
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
