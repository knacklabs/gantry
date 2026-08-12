import {
  Navigate,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type Router,
} from '@tanstack/react-router';

import { rootRoute } from './root-route';
import { administrationRoutes } from './routes/administration-routes';
import type { conversationRoutes } from './routes/conversation-routes';
import type { foundationRoutes } from './routes/foundation-routes';
import { operationsRoutes } from './routes/operations-routes';
import type { runtimeRoutes } from './routes/runtime-routes';
import type { workflowRoutes } from './routes/workflow-routes';

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <Navigate replace to="/overview" />,
});

const developmentRoutes = [
  import.meta.env.DEV
    ? createRoute({
        getParentRoute: () => rootRoute,
        path: '__components',
        component: lazyRouteComponent(
          () => import('../ui/lab/foundation-lab'),
          'FoundationLab',
        ),
      })
    : undefined,
  import.meta.env.DEV
    ? createRoute({
        getParentRoute: () => rootRoute,
        path: '__components/interactions',
        component: lazyRouteComponent(
          () => import('../ui/lab/interaction-lab'),
          'InteractionLab',
        ),
      })
    : undefined,
].filter((route) => route !== undefined);

const productRoutes = [
  homeRoute,
  ...operationsRoutes.slice(0, 3),
  ...administrationRoutes.slice(0, 2),
];

const previewRoutes = import.meta.env.DEV
  ? [
      ...operationsRoutes.slice(3),
      ...administrationRoutes.slice(2),
      ...developmentRoutes,
    ]
  : [];

const routeTree = rootRoute.addChildren([...productRoutes, ...previewRoutes]);

export const router = createRouter({
  basepath: '/ui',
  defaultPreload: 'intent',
  routeTree,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: Router<RegisteredRouteTree>;
  }
}

type RegisteredRoute =
  | (typeof foundationRoutes)[number]
  | (typeof operationsRoutes)[number]
  | (typeof administrationRoutes)[number]
  | (typeof conversationRoutes)[number]
  | (typeof runtimeRoutes)[number]
  | (typeof workflowRoutes)[number]
  | (typeof developmentRoutes)[number];

type RegisteredRouteTree = ReturnType<
  typeof rootRoute.addChildren<ReadonlyArray<RegisteredRoute>>
>;
