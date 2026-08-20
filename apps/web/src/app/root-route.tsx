import {
  createRootRoute,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { NotFoundRoute } from '../routes/not-found-route';
import { AuthLoadingPage } from '../features/auth/auth-pages';
import { AppShell } from './app-shell';

type BrowserSession = {
  absoluteExpiresAt: string;
};

function ProtectedAppShell() {
  const [session, setSession] = useState<BrowserSession | null | undefined>();

  useEffect(() => {
    void fetch('/ui/api/auth/session', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) {
          window.location.replace('/ui/auth/sign-in');
          setSession(null);
          return;
        }
        const body = await response.json();
        setSession({ absoluteExpiresAt: body.absoluteExpiresAt });
      })
      .catch(() => {
        window.location.replace('/ui/auth/sign-in');
        setSession(null);
      });
  }, []);

  if (session === undefined) return <AuthLoadingPage />;
  if (session === null) return null;
  const expiresSoon =
    new Date(session.absoluteExpiresAt).getTime() - Date.now() <= 5 * 60 * 1000;
  return (
    <>
      {expiresSoon ? (
        <div className="fixed top-3 right-3 z-50 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text shadow-panel">
          This session expires soon.{' '}
          <a className="underline" href="/ui/auth/reauthenticate">
            Sign in again
          </a>
        </div>
      ) : null}
      {new URLSearchParams(window.location.search).has('reauthenticated') ? (
        <p className="sr-only" role="status">
          Signed in again. Review and submit your changes.
        </p>
      ) : null}
      <AppShell />
    </>
  );
}

function RootLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  return pathname === '/auth' ||
    pathname.startsWith('/auth/') ||
    pathname === '/ui/auth' ||
    pathname.startsWith('/ui/auth/') ? (
    <Outlet />
  ) : (
    <ProtectedAppShell />
  );
}

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundRoute,
});
