import { createRoute, lazyRouteComponent } from '@tanstack/react-router';

import {
  conversationSearchSchema,
  diagnosticSearchSchema,
  interactionSearchSchema,
  providerSearchSchema,
} from '../../features/operations/operations-search';
import { activitySearchSchema } from '../../features/runtime/runtime-search';
import { rootRoute } from '../root-route';

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'overview',
  component: lazyRouteComponent(
    () => import('../../features/operations/routes/overview-route'),
    'OverviewRoute',
  ),
});

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'activity',
  validateSearch: activitySearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/operations/routes/activity-route'),
    'ActivityRoute',
  ),
});

const activityDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'activity/$runId',
  component: lazyRouteComponent(
    () => import('../../features/operations/routes/activity-detail-route'),
    'ActivityDetailRoute',
  ),
});

const metricsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'metrics',
  component: lazyRouteComponent(
    () => import('../../features/operations/routes/metrics-route'),
    'MetricsRoute',
  ),
});

const instancesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'instances',
  component: lazyRouteComponent(
    () => import('../../features/operations/routes/instances-route'),
    'InstancesRoute',
  ),
});

const instanceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'instances/$instanceId',
  component: lazyRouteComponent(
    () => import('../../features/operations/routes/instance-detail-route'),
    'InstanceDetailRoute',
  ),
});

const interactionsRoute = import.meta.env.DEV
  ? createRoute({
      getParentRoute: () => rootRoute,
      path: 'interactions',
      validateSearch: interactionSearchSchema,
      component: lazyRouteComponent(
        () => import('../../features/operations/routes/interactions-route'),
        'InteractionsRoute',
      ),
    })
  : undefined;

const providersRoute = import.meta.env.DEV
  ? createRoute({
      getParentRoute: () => rootRoute,
      path: 'providers',
      validateSearch: providerSearchSchema,
      component: lazyRouteComponent(
        () => import('../../features/operations/routes/providers-route'),
        'ProvidersRoute',
      ),
    })
  : undefined;

const conversationsRoute = import.meta.env.DEV
  ? createRoute({
      getParentRoute: () => rootRoute,
      path: 'conversations',
      validateSearch: conversationSearchSchema,
      component: lazyRouteComponent(
        () => import('../../features/operations/routes/conversations-route'),
        'ConversationsRoute',
      ),
    })
  : undefined;

const conversationDetailRoute = import.meta.env.DEV
  ? createRoute({
      getParentRoute: () => rootRoute,
      path: 'conversations/$conversationId',
      component: lazyRouteComponent(
        () =>
          import('../../features/operations/routes/conversation-detail-route'),
        'ConversationDetailRoute',
      ),
    })
  : undefined;

const diagnosticsRoute = import.meta.env.DEV
  ? createRoute({
      getParentRoute: () => rootRoute,
      path: 'diagnostics',
      validateSearch: diagnosticSearchSchema,
      component: lazyRouteComponent(
        () => import('../../features/operations/routes/diagnostics-route'),
        'DiagnosticsRoute',
      ),
    })
  : undefined;

export const operationsRoutes = [
  overviewRoute,
  activityRoute,
  activityDetailRoute,
  metricsRoute,
  instancesRoute,
  instanceDetailRoute,
  interactionsRoute,
  providersRoute,
  conversationsRoute,
  conversationDetailRoute,
  diagnosticsRoute,
].filter((route) => route !== undefined);
