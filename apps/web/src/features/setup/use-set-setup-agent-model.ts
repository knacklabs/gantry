import { useMutation } from '@tanstack/react-query';

import {
  requireRuntimeTransport,
  useRuntimeConnection,
} from '../../lib/api/runtime-connection';
import { setSetupAgentModel } from './agent-api';

export function useSetSetupAgentModel() {
  const connection = useRuntimeConnection();
  return useMutation({
    mutationFn: (input: { agentId: string; modelAlias: string }) =>
      setSetupAgentModel(requireRuntimeTransport(connection), input),
  });
}
