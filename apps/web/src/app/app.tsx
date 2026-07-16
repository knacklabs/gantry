import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';

import { PreferencesProvider } from '../features/preferences/preferences-provider';
import { queryClient } from '../lib/query/query-client';
import { ConnectionGateProvider } from '../ui/compositions/connection-gate';
import { router } from './router';

export function App() {
  return (
    <PreferencesProvider>
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider delayDuration={350}>
          <ConnectionGateProvider>
            <RouterProvider router={router} />
          </ConnectionGateProvider>
        </Tooltip.Provider>
      </QueryClientProvider>
    </PreferencesProvider>
  );
}
