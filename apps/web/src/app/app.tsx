import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { Toaster } from 'sonner';

import {
  PreferencesProvider,
  usePreferences,
} from '../features/preferences/preferences-provider';
import { queryClient } from '../lib/query/query-client';
import { TooltipProvider } from '../ui/primitives/tooltip';
import { ConnectionGateProvider } from '../ui/compositions/connection-gate';
import { router } from './router';

export function App() {
  return (
    <TooltipProvider>
      <PreferencesProvider>
        <QueryClientProvider client={queryClient}>
          <ConnectionGateProvider>
            <RouterProvider router={router} />
          </ConnectionGateProvider>
          <AppToaster />
        </QueryClientProvider>
      </PreferencesProvider>
    </TooltipProvider>
  );
}

function AppToaster() {
  const { effectiveTheme } = usePreferences();

  return (
    <Toaster
      closeButton
      duration={4_000}
      mobileOffset={{
        bottom: 'max(16px, env(safe-area-inset-bottom))',
        right: 16,
      }}
      offset={{ bottom: 'max(24px, env(safe-area-inset-bottom))', right: 24 }}
      position="bottom-right"
      theme={effectiveTheme}
      toastOptions={{
        unstyled: true,
        classNames: {
          actionButton: 'gantry-toast-action',
          closeButton: 'gantry-toast-close',
          content: 'gantry-toast-content',
          error: 'gantry-toast-error',
          success: 'gantry-toast-success',
          title: 'gantry-toast-title',
          toast: 'gantry-toast',
        },
      }}
    />
  );
}
