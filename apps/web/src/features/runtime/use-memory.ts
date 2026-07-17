import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  requireRuntimeTransport,
  useRuntimeConnection,
} from '../../lib/api/runtime-connection';
import {
  loadMemories,
  loadMemoryAgentId,
  loadMemoryDashboard,
  memoryQueryKeys,
  triggerMemoryDreaming,
} from './memory-api';

function useMemoryAgentId() {
  const connection = useRuntimeConnection();
  return useQuery({
    queryKey: memoryQueryKeys.agent(),
    enabled: Boolean(connection.transport),
    queryFn: () => loadMemoryAgentId(requireRuntimeTransport(connection)),
  });
}

export function useMemoryDashboard() {
  const connection = useRuntimeConnection();
  const agent = useMemoryAgentId();
  return useQuery({
    queryKey: memoryQueryKeys.dashboard(agent.data ?? null),
    enabled: Boolean(connection.transport) && agent.isSuccess,
    queryFn: () =>
      loadMemoryDashboard(
        requireRuntimeTransport(connection),
        agent.data ?? null,
      ),
  });
}

export function useMemories(query: string) {
  const connection = useRuntimeConnection();
  const agent = useMemoryAgentId();
  return useQuery({
    queryKey: memoryQueryKeys.list(agent.data ?? null, query.trim()),
    enabled: Boolean(connection.transport) && agent.isSuccess,
    queryFn: () =>
      loadMemories(
        requireRuntimeTransport(connection),
        query,
        agent.data ?? null,
      ),
  });
}

export function useTriggerMemoryDreaming() {
  const connection = useRuntimeConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const transport = requireRuntimeTransport(connection);
      let agentId = queryClient.getQueryData<string | null>(
        memoryQueryKeys.agent(),
      );
      if (agentId === undefined) agentId = await loadMemoryAgentId(transport);
      if (!agentId) throw new Error('No runtime agent is available');
      return triggerMemoryDreaming(transport, agentId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: memoryQueryKeys.all });
    },
  });
}
