import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

import { PreferencesProvider } from '../features/preferences/preferences-provider';
import {
  RuntimeConnectionProvider,
  type RuntimeConnection,
} from '../lib/api/runtime-connection';
import { queryClient } from '../lib/query/query-client';
import { ConnectionGateProvider } from '../ui/compositions/connection-gate';
import { router } from './router';

export function App({ connection }: { connection: RuntimeConnection }) {
  return (
    <PreferencesProvider>
      <RuntimeConnectionProvider connection={connection}>
        <QueryClientProvider client={queryClient}>
          <ConnectionGateProvider>
            <RouterProvider router={router} />
          </ConnectionGateProvider>
        </QueryClientProvider>
      </RuntimeConnectionProvider>
    </PreferencesProvider>
  );
}
