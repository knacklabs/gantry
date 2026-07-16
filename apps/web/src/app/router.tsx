import {
  Navigate,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';

import { AppShell } from './app-shell';
import {
  conversationSearchSchema,
  diagnosticSearchSchema,
  interactionSearchSchema,
  providerSearchSchema,
} from '../features/operations/operations-search';
import { NotFoundRoute } from '../routes/not-found-route';
import { PreferencesRoute } from '../features/preferences/preferences-route';

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: NotFoundRoute,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <Navigate replace to="/overview" />,
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'overview',
  component: lazyRouteComponent(
    () => import('../features/operations/routes/overview-route'),
    'OverviewRoute',
  ),
});

const interactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'interactions',
  validateSearch: interactionSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/operations/routes/interactions-route'),
    'InteractionsRoute',
  ),
});

const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'providers',
  validateSearch: providerSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/operations/routes/providers-route'),
    'ProvidersRoute',
  ),
});

const conversationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'conversations',
  validateSearch: conversationSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/operations/routes/conversations-route'),
    'ConversationsRoute',
  ),
});

const conversationDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'conversations/$conversationId',
  component: lazyRouteComponent(
    () => import('../features/operations/routes/conversation-detail-route'),
    'ConversationDetailRoute',
  ),
});

const diagnosticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'diagnostics',
  validateSearch: diagnosticSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/operations/routes/diagnostics-route'),
    'DiagnosticsRoute',
  ),
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

const productRoutes = [
  homeRoute,
  overviewRoute,
  interactionsRoute,
  providersRoute,
  conversationsRoute,
  conversationDetailRoute,
  diagnosticsRoute,
  profileRoute,
];

const routeTree = componentLabRoute
  ? rootRoute.addChildren([...productRoutes, componentLabRoute])
  : rootRoute.addChildren(productRoutes);

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
