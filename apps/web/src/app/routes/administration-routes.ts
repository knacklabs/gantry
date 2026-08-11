import { createRoute, lazyRouteComponent } from '@tanstack/react-router';

import {
  agentDetailSearchSchema,
  agentListSearchSchema,
  sourceSearchSchema,
} from '../../features/agents/agents-search';
import {
  peopleSearchSchema,
  personDetailSearchSchema,
} from '../../features/people/people-search';
import { rootRoute } from '../root-route';

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'agents',
  validateSearch: agentListSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/agents/routes/agents-route'),
    'AgentsRoute',
  ),
});

const agentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'agents/$agentId',
  validateSearch: agentDetailSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/agents/routes/agent-detail-route'),
    'AgentDetailRoute',
  ),
});

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'sources',
  validateSearch: sourceSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/agents/routes/sources-route'),
    'SourcesRoute',
  ),
});

const pauseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'pause',
  component: lazyRouteComponent(
    () => import('../../features/agents/routes/pause-route'),
    'PauseRoute',
  ),
});

const peopleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'people',
  validateSearch: peopleSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/people/routes/people-route'),
    'PeopleRoute',
  ),
});

const personDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'people/$personId',
  validateSearch: personDetailSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/people/routes/person-detail-route'),
    'PersonDetailRoute',
  ),
});

export const administrationRoutes = [
  agentsRoute,
  agentDetailRoute,
  sourcesRoute,
  pauseRoute,
  peopleRoute,
  personDetailRoute,
];
