import {
  Navigate,
  createRoute,
  lazyRouteComponent,
} from '@tanstack/react-router';

import { PreferencesRoute } from '../../features/preferences/preferences-route';
import { AuthLoadingPage } from '../../features/auth/auth-pages';
import { useOnboardingEligibility } from '../../features/onboarding/first-run';
import { rootRoute } from '../root-route';

function HomeRoute() {
  const eligibility = useOnboardingEligibility();
  if (eligibility.status === 'loading') return <AuthLoadingPage />;
  return (
    <Navigate
      replace
      to={
        eligibility.status === 'onboarding' || eligibility.status === 'fallback'
          ? '/onboarding'
          : '/overview'
      }
    />
  );
}

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeRoute,
});

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'profile',
  component: PreferencesRoute,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'onboarding',
  component: lazyRouteComponent(
    () => import('../../features/onboarding/onboarding-route'),
    'OnboardingRoute',
  ),
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

export const foundationRoutes = [homeRoute, profileRoute, onboardingRoute];
export const developmentRoutes = [
  componentLabRoute,
  interactionLabRoute,
].filter((route) => route !== undefined);
