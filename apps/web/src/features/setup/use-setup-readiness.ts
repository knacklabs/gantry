import { useMutation } from '@tanstack/react-query';

import {
  requireRuntimeTransport,
  useRuntimeConnection,
} from '../../lib/api/runtime-connection';
import { checkSetupHealth } from './readiness-api';

export function useSetupReadinessCheck() {
  const connection = useRuntimeConnection();
  return useMutation({
    mutationFn: () => checkSetupHealth(requireRuntimeTransport(connection)),
  });
}
