import { queryOptions } from '@tanstack/react-query';

import {
  conversations,
  diagnostics,
  interactions,
  providers,
} from './operations-preview';

export const operationsQueryKeys = {
  all: ['operations'] as const,
  providers: () => [...operationsQueryKeys.all, 'providers'] as const,
  conversations: () => [...operationsQueryKeys.all, 'conversations'] as const,
  interactions: () => [...operationsQueryKeys.all, 'interactions'] as const,
  diagnostics: () => [...operationsQueryKeys.all, 'diagnostics'] as const,
};

export const providerPreviewQuery = queryOptions({
  queryKey: operationsQueryKeys.providers(),
  queryFn: () => providers,
  initialData: providers,
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
