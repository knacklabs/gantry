import { queryOptions } from '@tanstack/react-query';

import { browserFetch } from '../../lib/auth/browser-auth';
import { conversations, diagnostics, interactions } from './operations-preview';

export const operationsQueryKeys = {
  all: ['operations'] as const,
  providers: () => [...operationsQueryKeys.all, 'providers'] as const,
  conversations: () => [...operationsQueryKeys.all, 'conversations'] as const,
  interactions: () => [...operationsQueryKeys.all, 'interactions'] as const,
  diagnostics: () => [...operationsQueryKeys.all, 'diagnostics'] as const,
};

export type ModelProvider = {
  providerId: string;
  label: string;
  configured: boolean;
  health: 'ready' | 'missing' | 'disabled';
  authMode: string | null;
  required: boolean;
  requiredBy: string[];
  supportedWorkloads: string[];
  updatedAt: string | null;
  credentialModes: Array<{
    id: string;
    label: string;
    helpText: string;
    fields: Array<{
      name: string;
      label: string;
      secret: boolean;
      required: boolean;
    }>;
  }>;
};

export const modelProviderQuery = queryOptions({
  queryKey: operationsQueryKeys.providers(),
  queryFn: async (): Promise<ModelProvider[]> => {
    const response = await browserFetch('/ui/api/model-providers', {
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('Model providers could not be loaded.');
    return ((await response.json()) as { providers: ModelProvider[] })
      .providers;
  },
});

export const conversationPreviewQuery = queryOptions({
  queryKey: operationsQueryKeys.conversations(),
  queryFn: () => conversations,
  initialData: conversations,
});

export const interactionPreviewQuery = queryOptions({
  queryKey: operationsQueryKeys.interactions(),
  queryFn: () => interactions,
  initialData: interactions,
});

export const diagnosticPreviewQuery = queryOptions({
  queryKey: operationsQueryKeys.diagnostics(),
  queryFn: () => diagnostics,
  initialData: diagnostics,
});
