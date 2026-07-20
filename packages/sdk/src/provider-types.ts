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
