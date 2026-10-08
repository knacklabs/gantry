import { Outlet } from '@tanstack/react-router';
import { Menu, Moon, Sun } from 'lucide-react';
import { useState } from 'react';

import {
  ConnectionState,
  useRuntimeConnection,
  type RuntimeConnectionState,
} from '../ui/compositions/connection-state';
import { Button } from '../ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '../ui/primitives/dialog';
import { usePreferences } from '../features/preferences/preferences-provider';
import { AppNavigation } from './app-navigation';

export function AppShell() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const { effectiveTheme, setTheme } = usePreferences();
  const runtime = useRuntimeConnection();
  const nextTheme = effectiveTheme === 'dark' ? 'light' : 'dark';
  const runtimeState: RuntimeConnectionState = runtime.isPending
    ? 'checking'
    : runtime.isError
      ? 'unavailable'
      : runtime.data.status;
  return (
    <>
      <div className="grid min-h-dvh grid-cols-[minmax(0,1fr)] bg-canvas md:grid-cols-[232px_minmax(0,1fr)]">
        <a
          className="absolute top-[-48px] left-3 z-30 bg-ink px-3 py-2 text-sm text-ink-on focus-visible:top-3"
          href="#main-content"
        >
          Skip to content
        </a>
        <aside
          aria-label="Primary navigation"
          className="sticky top-0 hidden h-dvh overflow-y-auto border-r border-border bg-surface px-3 pt-[18px] pb-4 md:block"
        >
          <AppNavigation />
        </aside>
        <div className="grid min-w-0 grid-rows-[64px_minmax(0,1fr)]">
          <header className="relative flex min-w-0 items-center justify-between border-b border-border bg-surface/95 px-4 sm:px-[26px]">
            <div className="flex min-w-0 items-center gap-3">
              <Dialog open={navigationOpen} onOpenChange={setNavigationOpen}>
                <DialogTrigger asChild>
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-11 md:hidden"
                    aria-label="Open navigation"
                  >
                    <Menu aria-hidden="true" />
                  </Button>
                </DialogTrigger>
                <DialogContent
                  aria-describedby={undefined}
                  className="top-0 left-0 h-dvh w-[min(288px,100vw)] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none bg-surface px-3 pt-4 pb-4 sm:max-w-none [&_a]:min-h-11"
                >
                  <DialogTitle className="sr-only">Navigation</DialogTitle>
                  <AppNavigation onNavigate={() => setNavigationOpen(false)} />
                </DialogContent>
              </Dialog>
              <ConnectionState state={runtimeState} />
            </div>
            <Button
              size="icon"
              variant="outline"
              aria-label={`Switch to ${nextTheme} theme`}
              title={`Switch to ${nextTheme} theme`}
              onClick={() => setTheme(nextTheme)}
            >
              {effectiveTheme === 'dark' ? (
                <Sun size={17} aria-hidden="true" />
              ) : (
                <Moon size={17} aria-hidden="true" />
              )}
            </Button>
          </header>
          <main
            id="main-content"
            tabIndex={-1}
            className="min-w-0 overflow-x-auto px-4 py-5 sm:px-7 sm:py-7"
          >
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}
