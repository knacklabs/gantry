import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  requireRuntimeTransport,
  useRuntimeConnection,
} from '../../lib/api/runtime-connection';
import { conversationQueryKeys } from '../operations/conversation-api';
import { createSetupAgent } from './agent-api';

export function useCreateSetupAgent() {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (name: string) =>
      createSetupAgent(requireRuntimeTransport(connection), {
        appId: connection.appId,
        name,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.dashboard(),
      });
    },
  });
}
