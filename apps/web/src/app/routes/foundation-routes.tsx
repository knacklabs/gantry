import {
  Navigate,
  createRoute,
  lazyRouteComponent,
} from '@tanstack/react-router';

import { PreferencesRoute } from '../../features/preferences/preferences-route';
import { rootRoute } from '../root-route';

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <Navigate replace to="/overview" />,
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
        () => import('../../ui/lab/foundation-lab'),
        'FoundationLab',
      ),
    })
  : undefined;

const interactionLabRoute = import.meta.env.DEV
  ? createRoute({
      getParentRoute: () => rootRoute,
      path: '__components/interactions',
      component: lazyRouteComponent(
        () => import('../../ui/lab/interaction-lab'),
        'InteractionLab',
      ),
    })
  : undefined;

export const foundationRoutes = [homeRoute, profileRoute];
export const developmentRoutes = [
  componentLabRoute,
  interactionLabRoute,
].filter((route) => route !== undefined);
