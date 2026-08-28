import {
  createRootRoute,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router';

import { NotFoundRoute } from '../routes/not-found-route';
import { AuthLoadingPage } from '../features/auth/auth-pages';
import {
  isBrowserAuthenticationMode,
  rememberBrowserAuthenticationMode,
  type BrowserAuthenticationMode,
} from '../lib/auth/browser-auth';
import { AppShell } from './app-shell';

type BrowserSession = {
  absoluteExpiresAt: string;
  mode: BrowserAuthenticationMode;
  principal: { role: 'administrator' | 'viewer' };
};

function isBrowserRole(value: unknown): value is 'administrator' | 'viewer' {
  return value === 'administrator' || value === 'viewer';
}

function isPublicAuthPath(pathname: string) {
  return (
    pathname === '/auth' ||
    pathname.startsWith('/auth/') ||
    pathname === '/ui/auth' ||
    pathname.startsWith('/ui/auth/')
  );
}

function ProtectedAppShell({ session }: { session: BrowserSession }) {
  const remainingMs =
    new Date(session.absoluteExpiresAt).getTime() - Date.now();
  const expiresSoon = remainingMs > 0 && remainingMs <= 60 * 1000;
  return (
    <>
      {expiresSoon ? (
        <div className="fixed top-3 right-3 z-50 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text shadow-panel">
          This session expires soon.{' '}
          <a
            className="underline"
            href={
              session.mode === 'local'
                ? '/ui/auth/local/reauthorize'
                : '/ui/auth/reauthenticate'
            }
          >
            {session.mode === 'local'
              ? 'Reauthorize this browser'
              : 'Sign in again'}
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
  beforeLoad: async ({ location }) => {
    if (isPublicAuthPath(location.pathname)) return { session: null };
    const bootstrap = await fetch('/ui/api/auth/session', {
      credentials: 'same-origin',
    })
      .then(async (response) => {
        const body: unknown = await response.json();
        const mode =
          typeof body === 'object' &&
          body !== null &&
          'mode' in body &&
          isBrowserAuthenticationMode(body.mode)
            ? body.mode
            : undefined;
        const role =
          typeof body === 'object' &&
          body !== null &&
          'principal' in body &&
          typeof body.principal === 'object' &&
          body.principal !== null &&
          'role' in body.principal &&
          isBrowserRole(body.principal.role)
            ? body.principal.role
            : undefined;
        const absoluteExpiresAt =
          typeof body === 'object' &&
          body !== null &&
          'absoluteExpiresAt' in body &&
          typeof body.absoluteExpiresAt === 'string'
            ? body.absoluteExpiresAt
            : undefined;
        if (!response.ok) return { mode, session: null };
        return mode && role && absoluteExpiresAt
          ? {
              mode,
              session: {
                absoluteExpiresAt,
                mode,
                principal: { role },
              },
            }
          : { mode, session: null };
      })
      .catch(() => ({ mode: undefined, session: null }));
    if (!bootstrap.session) {
      const target = new URL(
        bootstrap.mode === 'local' ? '/ui/auth/local' : '/ui/auth/sign-in',
        window.location.origin,
      );
      if (bootstrap.mode === 'local') {
        target.searchParams.set('reason', 'session-expired');
      }
      throw redirect({ href: target.toString() });
    }
    rememberBrowserAuthenticationMode(bootstrap.session.mode);
    return { session: bootstrap.session };
  },
  component: RootLayout,
  notFoundComponent: NotFoundRoute,
  pendingComponent: AuthLoadingPage,
  pendingMs: 0,
});
