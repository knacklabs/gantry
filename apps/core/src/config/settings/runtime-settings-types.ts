import type {
  RuntimeMemorySettingsSnapshot,
  RuntimeStorageSettingsSnapshot,
} from './memory-snapshot.js';
import type { AgentPersona } from '../../shared/agent-persona.js';
import type { GuardrailConfig } from '../../domain/types.js';
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
  // runtime synthesizes a per-customer route on first inbound message.
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
export type MemoryModelProfile = 'cheap' | 'balanced' | 'quality';
export type MemoryModelTask = 'extractor' | 'dreaming' | 'consolidation';

export interface RuntimeMemoryLlmModels {
  extractor: string;
  dreaming: string;
  consolidation: string;
}

export interface RuntimeMemorySettings {
  enabled: boolean;
  embeddings: {
    enabled: boolean;
    provider: EmbeddingProviderName;
    model: string;
    dailyLimit: number;
    batchSize: number;
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
  memoryScope: 'conversation' | 'thread' | 'user' | 'agent';
  model?: string;
}

export interface RuntimeConfiguredAgentCapabilities {
  toolIds: string[];
  skillIds: string[];
  mcpServerIds: string[];
}

export type RuntimeConfiguredAgentGuardrail = GuardrailConfig;

export interface RuntimeConfiguredAgent {
  name: string;
  folder: string;
  persona?: AgentPersona;
  model?: string;
  oneTimeJobDefaultModel?: string;
  recurringJobDefaultModel?: string;
  guardrail?: RuntimeConfiguredAgentGuardrail;
  bindings: Record<string, RuntimeConfiguredAgentBinding>;
  capabilities: RuntimeConfiguredAgentCapabilities;
}

export interface RuntimeDesiredStateSettings {
  authoritative: boolean;
}

export type RuntimeCredentialBrokerMode = 'none' | 'onecli' | 'external';

export interface RuntimeCredentialBrokerSettings {
  mode: RuntimeCredentialBrokerMode;
  onecli: {
    url: string;
    postgres: {
      urlEnv: string;
      schema: string;
    };
  };
  external: {
    baseUrl: string;
  };
}

export type { RuntimeMemorySettingsSnapshot, RuntimeStorageSettingsSnapshot };

export interface RuntimeQueueSettings {
  maxMessageRuns: number;
  maxJobRuns: number;
  maxRetries: number;
  baseRetryMs: number;
}

export interface RuntimeProcessSettings {
  queue: RuntimeQueueSettings;
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
