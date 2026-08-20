import {
  createRootRoute,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router';

import { NotFoundRoute } from '../routes/not-found-route';
import { AuthLoadingPage } from '../features/auth/auth-pages';
import { AppShell } from './app-shell';

type BrowserSession = {
  absoluteExpiresAt: string;
};

function isPublicAuthPath(pathname: string) {
  return (
    pathname === '/auth' ||
    pathname.startsWith('/auth/') ||
    pathname === '/ui/auth' ||
    pathname.startsWith('/ui/auth/')
  );
}

function ProtectedAppShell({ session }: { session: BrowserSession }) {
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
  const { session } = rootRoute.useRouteContext();
  return isPublicAuthPath(pathname) || !session ? (
    <Outlet />
  ) : (
    <ProtectedAppShell session={session} />
  );
}

export const rootRoute = createRootRoute({
  beforeLoad: async ({ abortController, location }) => {
    if (isPublicAuthPath(location.pathname)) return { session: null };
    const session = await fetch('/ui/api/auth/session', {
      credentials: 'same-origin',
      signal: abortController.signal,
    })
      .then(async (response): Promise<BrowserSession | null> => {
        if (!response.ok) return null;
        const body: unknown = await response.json();
        return typeof body === 'object' &&
          body !== null &&
          'absoluteExpiresAt' in body &&
          typeof body.absoluteExpiresAt === 'string'
          ? { absoluteExpiresAt: body.absoluteExpiresAt }
          : null;
      })
      .catch(() => null);
    if (!session) throw redirect({ to: '/auth/sign-in' });
    return { session };
  },
  component: RootLayout,
  notFoundComponent: NotFoundRoute,
  pendingComponent: AuthLoadingPage,
  pendingMs: 0,
});
