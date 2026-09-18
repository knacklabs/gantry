import { Outlet } from '@tanstack/react-router';
import { Maximize2, Minimize2, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  ConnectionState,
  useRuntimeConnection,
  type RuntimeConnectionState,
} from '../ui/compositions/connection-state';
import { Button } from '../ui/primitives/button';
import { usePreferences } from '../features/preferences/preferences-provider';
import { AppNavigation } from './app-navigation';

export function AppShell() {
  const { effectiveTheme, setTheme } = usePreferences();
  const runtime = useRuntimeConnection();
  const nextTheme = effectiveTheme === 'dark' ? 'light' : 'dark';
  const [collapsed, setCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const runtimeState: RuntimeConnectionState = runtime.isPending
    ? 'checking'
    : runtime.isError
      ? 'unavailable'
      : runtime.data.status;
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
      <div
        className="relative hidden min-h-dvh bg-canvas transition-[grid-template-columns] duration-[260ms] ease-gantry md:grid"
        style={{ gridTemplateColumns: `${collapsed ? '58px' : '232px'} minmax(0, 1fr)` }}
      >
        <span aria-hidden="true" className="pointer-events-none fixed top-[-160px] left-[-120px] size-[520px] rounded-full bg-[radial-gradient(circle,rgb(95_174_140_/_16%),transparent_65%)]" />
        <a
          className="absolute top-[-48px] left-3 z-30 bg-ink px-3 py-2 text-sm text-ink-on focus-visible:top-3"
          href="#main-content"
        >
          Skip to content
        </a>
        <aside
          id="primary-navigation"
          aria-label="Primary navigation"
          className="sticky top-0 z-10 h-dvh overflow-x-hidden overflow-y-auto border-r border-white/20 bg-[linear-gradient(180deg,rgb(127_127_127_/_10%),rgb(127_127_127_/_4%))] px-[10px] pt-[14px] pb-[12px] shadow-[inset_-1px_0_0_rgb(255_255_255_/_4%)] backdrop-blur-[22px] backdrop-saturate-150"
        >
          <AppNavigation collapsed={collapsed} onToggleCollapse={() => setCollapsed((value) => !value)} />
        </aside>
        <div className="relative grid min-w-0 grid-rows-[52px_minmax(0,1fr)]">
          <header className="relative flex min-w-0 items-center justify-end gap-[10px] border-b border-border bg-canvas px-[22px]">
            <div className="sr-only" aria-live="polite"><ConnectionState state={runtimeState} /></div>
            <span aria-hidden="true" className="absolute right-0 bottom-[-1px] left-0 h-[3px] bg-status-success" />
            <Button size="icon" variant="outline" aria-label={`Switch to ${nextTheme} theme`} onClick={() => setTheme(nextTheme)}>{effectiveTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</Button>
            <Button size="icon" variant="outline" aria-label={fullscreen ? 'Exit full screen' : 'Enter full screen'} onClick={() => void (fullscreen ? document.exitFullscreen() : document.documentElement.requestFullscreen())}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</Button>
          </header>
          <main id="main-content" className="min-w-0 overflow-y-auto px-[22px] pt-5 pb-[26px]">
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}
