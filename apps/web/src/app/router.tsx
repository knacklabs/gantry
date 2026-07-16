import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';

import { AppShell } from './app-shell';
import { HomeRoute } from '../routes/home-route';
import { NotFoundRoute } from '../routes/not-found-route';
import { PreferencesRoute } from '../features/preferences/preferences-route';

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: NotFoundRoute,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeRoute,
});

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'profile',
  component: PreferencesRoute,
});

const componentLabRoute = import.meta.env.DEV
  ? createRoute({
      getParentRoute: () => rootRoute,
      path: '__components',
      component: lazyRouteComponent(
        () => import('../ui/lab/foundation-lab'),
        'FoundationLab',
      ),
    })
  : undefined;

const routeTree = componentLabRoute
  ? rootRoute.addChildren([homeRoute, profileRoute, componentLabRoute])
  : rootRoute.addChildren([homeRoute, profileRoute]);

export const router = createRouter({
  basepath: '/ui',
  defaultPreload: 'intent',
  routeTree,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
