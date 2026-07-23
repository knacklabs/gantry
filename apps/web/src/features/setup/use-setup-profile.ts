import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  requireRuntimeTransport,
  useRuntimeConnection,
} from '../../lib/api/runtime-connection';
import { loadSetupProfile, saveSetupProfile } from './profile-api';

const profileQueryKey = (agentId: string) => ['setup', 'profile', agentId];

export function useSetupProfile(agentId?: string) {
  const connection = useRuntimeConnection();
  return useQuery({
    queryKey: profileQueryKey(agentId ?? 'not-created'),
    enabled: Boolean(connection.transport && agentId),
    queryFn: () =>
      loadSetupProfile(requireRuntimeTransport(connection), agentId as string),
  });
}

export function useSaveSetupProfile() {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      agentId: string;
      content: string;
      expectedVersion?: number;
    }) => saveSetupProfile(requireRuntimeTransport(connection), input),
    onSuccess: async (file) => {
      await queryClient.setQueryData(profileQueryKey(file.agentId), file);
    },
  });
}
