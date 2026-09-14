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
          closeButton:
            'absolute right-2 top-2 inline-flex size-5 items-center justify-center rounded-sm border border-border bg-surface-muted text-text-muted transition-colors hover:bg-surface-strong hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
          content: 'gap-1.5 pr-5',
          error: 'border-danger',
          success: 'border-status-success',
          title: 'font-sans text-[13px] font-medium leading-5 text-text',
          toast:
            'relative flex w-[min(360px,calc(100vw-32px))] items-start gap-2 rounded-lg border border-border-strong bg-surface px-3 py-2.5 font-sans text-text shadow-popover motion-reduce:transition-none',
        },
      }}
    />
  );
}
