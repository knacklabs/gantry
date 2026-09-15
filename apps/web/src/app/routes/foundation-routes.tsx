import {
  Navigate,
  createRoute,
  lazyRouteComponent,
} from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { PreferencesRoute } from '../../features/preferences/preferences-route';
import { browserFetch } from '../../lib/auth/browser-auth';
import { rootRoute } from '../root-route';

function HomeRoute() {
  const status = useQuery({
    queryKey: ['onboarding-status'],
    queryFn: async () => {
      const response = await browserFetch('/ui/api/onboarding/status', {
        credentials: 'same-origin',
      });
      if (!response.ok)
        throw new Error('Onboarding status could not be loaded.');
      return response.json() as Promise<{
        firstRun: boolean;
        resume: unknown | null;
      }>;
    },
  });
  if (status.isPending) return null;
  if (status.isError)
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas p-6 text-text">
        <div className="grid justify-items-center gap-3 text-center">
          <p className="m-0">Gantry could not load onboarding status.</p>
          <button
            className="rounded-md border border-border px-3 py-2"
            onClick={() => void status.refetch()}
          >
            Retry
          </button>
        </div>
      </main>
    );
  return (
    <Navigate
      replace
      to={
        status.data?.firstRun || status.data?.resume
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
    () => import('../../features/onboarding/onboarding-flow'),
    'OnboardingFlow',
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
