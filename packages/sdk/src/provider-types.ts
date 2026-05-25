export type ProviderConnectionInput = {
  appId: string;
  providerId: string;
  label: string;
  config?: Record<string, unknown>;
  externalRef?: Record<string, unknown>;
  runtimeSecretRefs?: string[];
  enabled?: boolean;
  metadata?: Record<string, unknown>;
};

export type ProviderConnectionPatch = {
  label?: string;
  status?: 'active' | 'inactive' | 'disabled' | 'archived';
  config?: Record<string, unknown>;
  externalRef?: Record<string, unknown> | null;
  runtimeSecretRefs?: string[];
  enabled?: boolean;
  metadata?: Record<string, unknown>;
};

export type ConversationDiscoveryInput = {
  query?: string;
  limit?: number;
  includeArchived?: boolean;
  providerMetadata?: Record<string, unknown>;
};

export type AgentConversationBindingInput = {
  providerConnectionId?: string;
  threadId?: string;
  displayName?: string;
  triggerMode?: 'always' | 'mention' | 'keyword' | 'manual' | 'webhook';
  triggerPattern?: string | null;
  requiresTrigger?: boolean;
  memoryScope?: 'user' | 'conversation' | 'agent' | 'app';
  memorySubject?: Record<string, unknown>;
  workspaceSnapshotId?: string | null;
  permissionPolicyIds?: string[];
  status?: 'active' | 'disabled';
  metadata?: Record<string, unknown>;
};
