import { createRoute, lazyRouteComponent } from '@tanstack/react-router';

import {
  chatDetailSearchSchema,
  chatListSearchSchema,
  memorySearchSchema,
} from '../../features/chat/chat-search';
import { rootRoute } from '../root-route';

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'chat',
  validateSearch: chatListSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/chat/routes/chat-route'),
    'ChatRoute',
  ),
});

const chatDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'chat/$sessionId',
  validateSearch: chatDetailSearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/chat/routes/chat-detail-route'),
    'ChatDetailRoute',
  ),
});

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'memory',
  validateSearch: memorySearchSchema,
  component: lazyRouteComponent(
    () => import('../../features/chat/routes/memory-route'),
    'MemoryRoute',
  ),
});

export const conversationRoutes = [chatRoute, chatDetailRoute, memoryRoute];
