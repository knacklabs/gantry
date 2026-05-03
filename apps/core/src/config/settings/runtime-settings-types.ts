import type {
  RuntimeMemorySettingsSnapshot,
  RuntimeStorageSettingsSnapshot,
} from './memory-snapshot.js';
import type { AgentPersona } from '../../shared/agent-persona.js';

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
  };
  dreaming: {
    enabled: boolean;
  };
  llm: {
    models: RuntimeMemoryLlmModels;
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

export interface RuntimeConfiguredAgentDmAccessEntry {
  provider: string;
  userIds: string[];
  adminUserId?: string;
}

export interface RuntimeConfiguredAgentBinding {
  jid: string;
  provider?: string;
  name?: string;
  trigger: string;
  addedAt: string;
  requiresTrigger: boolean;
  isMain: boolean;
  model?: string;
}

export interface RuntimeConfiguredBinding {
  agent: string;
  conversation: string;
  trigger: string;
  addedAt: string;
  requiresTrigger: boolean;
  isMain: boolean;
  memoryScope: 'conversation' | 'thread' | 'user' | 'agent';
  model?: string;
}

export interface RuntimeConfiguredAgentCapabilities {
  toolIds: string[];
  skillIds: string[];
  mcpServerIds: string[];
}

export interface RuntimeConfiguredAgent {
  name: string;
  folder: string;
  persona?: AgentPersona;
  model?: string;
  oneTimeJobDefaultModel?: string;
  recurringJobDefaultModel?: string;
  bindings: Record<string, RuntimeConfiguredAgentBinding>;
  dmAccess: RuntimeConfiguredAgentDmAccessEntry[];
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
