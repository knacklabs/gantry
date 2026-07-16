import * as Dialog from '@radix-ui/react-dialog';
import { Outlet } from '@tanstack/react-router';
import { Menu, Moon, Sun, X } from 'lucide-react';
import { useRef, useState } from 'react';

import { ConnectionState } from '../ui/compositions/connection-state';
import { IconButton } from '../ui/primitives/icon-button';
import { usePreferences } from '../features/preferences/preferences-provider';
import { AppNavigation } from './app-navigation';

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const { effectiveTheme, setTheme } = usePreferences();
  const nextTheme = effectiveTheme === 'dark' ? 'light' : 'dark';

  function changeDrawer(open: boolean) {
    setDrawerOpen(open);
    if (!open) queueMicrotask(() => drawerReturnFocusRef.current?.focus());
  }

  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[232px_minmax(0,1fr)]">
      <a
        className="absolute top-[-48px] left-3 z-30 bg-ink px-3 py-2 text-sm text-ink-on focus-visible:top-3"
        href="#main-content"
      >
        Skip to content
      </a>
      <aside
        aria-label="Primary navigation"
        className="sticky top-0 hidden h-dvh overflow-y-auto border-r border-border bg-surface px-3 pt-[18px] pb-4 lg:block"
      >
        <AppNavigation />
      </aside>
      <Dialog.Root open={drawerOpen} onOpenChange={changeDrawer}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-20 bg-black/35 lg:hidden" />
          <Dialog.Content
            aria-label="Navigation"
            className="fixed inset-y-0 left-0 z-[21] w-[min(284px,calc(100vw-32px))] overflow-y-auto border-r border-border bg-surface px-3 pt-[18px] pb-4 shadow-drawer lg:hidden"
          >
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton
                aria-label="Close navigation"
                className="absolute top-[14px] right-[14px]"
                title="Close navigation"
              >
                <X size={18} aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
            <AppNavigation onNavigate={() => changeDrawer(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <div className="grid min-w-0 grid-rows-[64px_minmax(0,1fr)]">
        <header className="relative flex min-w-0 items-center justify-between border-b border-border bg-canvas/90 px-4 after:absolute after:right-0 after:bottom-[-1px] after:left-0 after:h-[3px] after:bg-status-idle sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="lg:hidden">
              <IconButton
                aria-label="Open navigation"
                title="Open navigation"
                onClick={(event) => {
                  drawerReturnFocusRef.current = event.currentTarget;
                  setDrawerOpen(true);
                }}
              >
                <Menu size={18} aria-hidden="true" />
              </IconButton>
            </div>
            <ConnectionState />
          </div>
          <IconButton
            aria-label={`Switch to ${nextTheme} theme`}
            title={`Switch to ${nextTheme} theme`}
            onClick={() => setTheme(nextTheme)}
          >
            {effectiveTheme === 'dark' ? (
              <Sun size={17} aria-hidden="true" />
            ) : (
              <Moon size={17} aria-hidden="true" />
            )}
          </IconButton>
        </header>
        <main id="main-content" className="min-w-0 px-4 py-6 sm:px-6 sm:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
