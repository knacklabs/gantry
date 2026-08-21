import { createRoute, lazyRouteComponent } from '@tanstack/react-router';

import {
  newWorkflowSearchSchema,
  workflowEditorSearchSchema,
  workflowSearchSchema,
} from '../../features/workflows/workflows-search';
import { rootRoute } from '../root-route';

const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workflows',
  validateSearch: workflowSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/workflows/routes/workflows-route'),
    'WorkflowsRoute',
  ),
});

const newWorkflowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workflows/new',
  validateSearch: newWorkflowSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/workflows/routes/new-workflow-route'),
    'NewWorkflowRoute',
  ),
});

const workflowEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workflows/$workflowId/edit',
  validateSearch: workflowEditorSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/workflows/routes/workflow-editor-route'),
    'WorkflowEditorRoute',
  ),
});

const workflowRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workflows/$workflowId/runs/$runId',
  component: lazyRouteComponent(
    () => import('../../features/workflows/routes/workflow-run-route'),
    'WorkflowRunRoute',
  ),
});

const externalSystemsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'workflows/external',
  component: lazyRouteComponent(
    () => import('../../features/workflows/routes/external-systems-route'),
    'ExternalSystemsRoute',
  ),
});

export const workflowRoutes = [
  workflowsRoute,
  newWorkflowRoute,
  workflowEditorRoute,
  workflowRunRoute,
  externalSystemsRoute,
];
