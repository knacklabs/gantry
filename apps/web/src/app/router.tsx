import { createRouter } from '@tanstack/react-router';

import { rootRoute } from './root-route';
import { administrationRoutes } from './routes/administration-routes';
import { conversationRoutes } from './routes/conversation-routes';
import {
  developmentRoutes,
  foundationRoutes,
} from './routes/foundation-routes';
import { operationsRoutes } from './routes/operations-routes';
import { runtimeRoutes } from './routes/runtime-routes';
import { workflowRoutes } from './routes/workflow-routes';

const productRoutes = [
  ...foundationRoutes,
  ...operationsRoutes,
  ...administrationRoutes,
  ...conversationRoutes,
  ...runtimeRoutes,
  ...workflowRoutes,
];

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
