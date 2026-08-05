import { createRootRoute } from '@tanstack/react-router';

import { NotFoundRoute } from '../routes/not-found-route';
import { AppShell } from './app-shell';

export const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: NotFoundRoute,
});
