import { createRoute, lazyRouteComponent } from '@tanstack/react-router';

import {
  activitySearchSchema,
  jobDetailSearchSchema,
  jobSearchSchema,
  modelSearchSchema,
} from '../../features/runtime/runtime-search';
import { rootRoute } from '../root-route';

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'jobs',
  validateSearch: jobSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/runtime/routes/jobs-route'),
    'JobsRoute',
  ),
});

const jobDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'jobs/$jobId',
  validateSearch: jobDetailSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/runtime/routes/job-detail-route'),
    'JobDetailRoute',
  ),
});

const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runtime/models',
  validateSearch: modelSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/runtime/routes/models-route'),
    'ModelsRoute',
  ),
});

const memoryEngineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runtime/memory',
  component: lazyRouteComponent(
    () => import('../../features/runtime/routes/memory-engine-route'),
    'MemoryEngineRoute',
  ),
});

const capacityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runtime/capacity',
  component: lazyRouteComponent(
    () => import('../../features/runtime/routes/capacity-route'),
    'CapacityRoute',
  ),
});

const guardrailsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'runtime/guardrails',
  component: lazyRouteComponent(
    () => import('../../features/runtime/routes/guardrails-route'),
    'GuardrailsRoute',
  ),
});

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'activity',
  validateSearch: activitySearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/runtime/routes/activity-route'),
    'ActivityRoute',
  ),
});

export const runtimeRoutes = [
  jobsRoute,
  jobDetailRoute,
  modelsRoute,
  memoryEngineRoute,
  capacityRoute,
  guardrailsRoute,
  activityRoute,
];
