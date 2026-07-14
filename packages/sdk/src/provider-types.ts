export type ProviderAccountInput = {
  appId: string;
  agentId: string;
  providerId: string;
  label: string;
  config?: Record<string, unknown>;
  externalRef?: Record<string, unknown>;
  runtimeSecretRefs?: Record<string, string>;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
};

export type ProviderAccountPatch = {
  label?: string;
  status?: 'active' | 'inactive' | 'disabled' | 'archived';
  config?: Record<string, unknown>;
  externalRef?: Record<string, unknown> | null;
  runtimeSecretRefs?: Record<string, string>;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
};

export type ConversationDiscoveryInput = {
  query?: string;
  limit?: number;
  includeArchived?: boolean;
  providerMetadata?: Record<string, unknown>;
};

export type ConversationInstallInput = {
  providerAccountId?: string;
  threadId?: string;
  displayName?: string;
  memoryScope?: 'user' | 'conversation' | 'agent' | 'app';
  memorySubject?: Record<string, unknown>;
  routeConfig?: {
    trigger?: string;
    requiresTrigger?: boolean;
    agentConfig?: Record<string, unknown>;
  };
  workspaceSnapshotId?: string | null;
  permissionPolicyIds?: string[];
  status?: 'active' | 'disabled';
  metadata?: Record<string, unknown>;
};
