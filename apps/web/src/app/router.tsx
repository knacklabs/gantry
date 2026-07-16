import {
  Navigate,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';

import { AppShell } from './app-shell';
import {
  agentDetailSearchSchema,
  agentListSearchSchema,
  sourceSearchSchema,
} from '../features/agents/agents-search';
import {
  chatDetailSearchSchema,
  chatListSearchSchema,
  memorySearchSchema,
} from '../features/chat/chat-search';
import {
  activitySearchSchema,
  jobDetailSearchSchema,
  jobSearchSchema,
  modelSearchSchema,
} from '../features/runtime/runtime-search';
import {
  peopleSearchSchema,
  personDetailSearchSchema,
} from '../features/people/people-search';
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

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'agents',
  validateSearch: agentListSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/agents/routes/agents-route'),
    'AgentsRoute',
  ),
});

const agentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'agents/$agentId',
  validateSearch: agentDetailSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/agents/routes/agent-detail-route'),
    'AgentDetailRoute',
  ),
});

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sources',
  validateSearch: sourceSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/agents/routes/sources-route'),
    'SourcesRoute',
  ),
});

const pauseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'pause',
  component: lazyRouteComponent(
    () => import('../features/agents/routes/pause-route'),
    'PauseRoute',
  ),
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'chat',
  validateSearch: chatListSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/chat/routes/chat-route'),
    'ChatRoute',
  ),
});

const chatDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'chat/$sessionId',
  validateSearch: chatDetailSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/chat/routes/chat-detail-route'),
    'ChatDetailRoute',
  ),
});

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'memory',
  validateSearch: memorySearchSchema,
  component: lazyRouteComponent(
    () => import('../features/chat/routes/memory-route'),
    'MemoryRoute',
  ),
});

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'jobs',
  validateSearch: jobSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/runtime/routes/jobs-route'),
    'JobsRoute',
  ),
});

const jobDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'jobs/$jobId',
  validateSearch: jobDetailSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/runtime/routes/job-detail-route'),
    'JobDetailRoute',
  ),
});

const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runtime/models',
  validateSearch: modelSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/runtime/routes/models-route'),
    'ModelsRoute',
  ),
});

const memoryEngineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runtime/memory',
  component: lazyRouteComponent(
    () => import('../features/runtime/routes/memory-engine-route'),
    'MemoryEngineRoute',
  ),
});

const capacityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runtime/capacity',
  component: lazyRouteComponent(
    () => import('../features/runtime/routes/capacity-route'),
    'CapacityRoute',
  ),
});

const guardrailsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runtime/guardrails',
  component: lazyRouteComponent(
    () => import('../features/runtime/routes/guardrails-route'),
    'GuardrailsRoute',
  ),
});

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'activity',
  validateSearch: activitySearchSchema,
  component: lazyRouteComponent(
    () => import('../features/runtime/routes/activity-route'),
    'ActivityRoute',
  ),
});

const peopleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'people',
  validateSearch: peopleSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/people/routes/people-route'),
    'PeopleRoute',
  ),
});

const personDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'people/$personId',
  validateSearch: personDetailSearchSchema,
  component: lazyRouteComponent(
    () => import('../features/people/routes/person-detail-route'),
    'PersonDetailRoute',
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

const interactionLabRoute = import.meta.env.DEV
  ? createRoute({
      getParentRoute: () => rootRoute,
      path: '__components/interactions',
      component: lazyRouteComponent(
        () => import('../ui/lab/interaction-lab'),
        'InteractionLab',
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
  agentsRoute,
  agentDetailRoute,
  sourcesRoute,
  pauseRoute,
  chatRoute,
  chatDetailRoute,
  memoryRoute,
  jobsRoute,
  jobDetailRoute,
  modelsRoute,
  memoryEngineRoute,
  capacityRoute,
  guardrailsRoute,
  activityRoute,
  peopleRoute,
  personDetailRoute,
  profileRoute,
];

const developmentRoutes = [componentLabRoute, interactionLabRoute].filter(
  (route) => route !== undefined,
);

const routeTree = developmentRoutes.length
  ? rootRoute.addChildren([...productRoutes, ...developmentRoutes])
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
