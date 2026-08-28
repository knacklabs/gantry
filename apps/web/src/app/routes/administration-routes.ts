import { createRoute, lazyRouteComponent } from '@tanstack/react-router';

import {
  agentDetailSearchSchema,
  agentListSearchSchema,
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

const agentCreateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'agents/new',
  component: lazyRouteComponent(
    () => import('../../features/agents/routes/agent-create-route'),
    'AgentCreateRoute',
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
  agentCreateRoute,
  agentDetailRoute,
  peopleRoute,
  personDetailRoute,
];
