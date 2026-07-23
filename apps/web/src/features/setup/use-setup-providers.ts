import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  requireRuntimeTransport,
  useRuntimeConnection,
} from '../../lib/api/runtime-connection';
import { conversationQueryKeys } from '../operations/conversation-api';
import { createSetupProviderAccount, loadSetupProviders } from './provider-api';

const providersQueryKey = ['setup', 'providers'];

export function useSetupProviders() {
  const connection = useRuntimeConnection();
  return useQuery({
    queryKey: providersQueryKey,
    enabled: Boolean(connection.transport),
    queryFn: () => loadSetupProviders(requireRuntimeTransport(connection)),
  });
}

export function useCreateSetupProviderAccount() {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      agentId: string;
      providerId: string;
      label: string;
      runtimeSecretRefs?: Record<string, string>;
    }) =>
      createSetupProviderAccount(requireRuntimeTransport(connection), {
        appId: connection.appId,
        ...input,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.all,
      });
    },
  });
}
