import { createRoute, lazyRouteComponent } from '@tanstack/react-router';

import {
  conversationSearchSchema,
  diagnosticSearchSchema,
  interactionSearchSchema,
  providerSearchSchema,
} from '../../features/operations/operations-search';
import { rootRoute } from '../root-route';

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'overview',
  component: lazyRouteComponent(
    () => import('../../features/operations/routes/overview-route'),
    'OverviewRoute',
  ),
});

const interactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'interactions',
  validateSearch: interactionSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/operations/routes/interactions-route'),
    'InteractionsRoute',
  ),
});

const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'providers',
  validateSearch: providerSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/operations/routes/providers-route'),
    'ProvidersRoute',
  ),
});

const conversationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'conversations',
  validateSearch: conversationSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/operations/routes/conversations-route'),
    'ConversationsRoute',
  ),
});

const conversationDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'conversations/$conversationId',
  component: lazyRouteComponent(
    () => import('../../features/operations/routes/conversation-detail-route'),
    'ConversationDetailRoute',
  ),
});

const diagnosticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'diagnostics',
  validateSearch: diagnosticSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/operations/routes/diagnostics-route'),
    'DiagnosticsRoute',
  ),
});

export const operationsRoutes = [
  overviewRoute,
  interactionsRoute,
  providersRoute,
  conversationsRoute,
  conversationDetailRoute,
  diagnosticsRoute,
];
