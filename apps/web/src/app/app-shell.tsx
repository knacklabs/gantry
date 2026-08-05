import { Outlet } from '@tanstack/react-router';
import { Moon, Sun } from 'lucide-react';

import { ConnectionState } from '../ui/compositions/connection-state';
import { Button } from '../ui/primitives/button';
import { usePreferences } from '../features/preferences/preferences-provider';
import { AppNavigation } from './app-navigation';

export function AppShell() {
  const { effectiveTheme, setTheme } = usePreferences();
  const nextTheme = effectiveTheme === 'dark' ? 'light' : 'dark';

  return (
    <>
      <div className="flex min-h-dvh items-center justify-center bg-canvas p-6 text-center md:hidden">
        <div className="max-w-sm rounded-lg border border-border bg-surface p-6 shadow-panel">
          <p className="m-0 text-sm font-semibold text-text">
            Tablet or desktop required
          </p>
          <p className="mt-2 mb-0 text-sm leading-6 text-text-secondary">
            Gantry preview is available from 768px wide screens.
          </p>
        </div>
      </div>
      <div className="hidden min-h-dvh bg-canvas md:grid md:grid-cols-[232px_minmax(0,1fr)]">
        <a
          className="absolute top-[-48px] left-3 z-30 bg-ink px-3 py-2 text-sm text-ink-on focus-visible:top-3"
          href="#main-content"
        >
          Skip to content
        </a>
        <aside
          aria-label="Primary navigation"
          className="sticky top-0 h-dvh overflow-y-auto border-r border-border bg-surface px-3 pt-[18px] pb-4"
        >
          <AppNavigation />
        </aside>
        <div className="grid min-w-0 grid-rows-[64px_minmax(0,1fr)]">
          <header className="relative flex min-w-0 items-center justify-between border-b border-border bg-canvas/90 px-4 after:absolute after:right-0 after:bottom-[-1px] after:left-0 after:h-[3px] after:bg-status-idle sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <ConnectionState />
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
          <main id="main-content" className="min-w-0 px-4 py-6 sm:px-6 sm:py-8">
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}
