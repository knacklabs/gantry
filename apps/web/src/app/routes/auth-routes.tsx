import { createRoute } from '@tanstack/react-router';

import {
  LocalAuthorizationPage,
  LocalReauthorizationPage,
  HostedSignInPage,
  NoAccessPage,
  CallbackFailurePage,
  HostedSetupPage,
  InvitationPage,
  ReauthenticationPage,
} from '../../features/auth/auth-pages';
import { AuthenticationAccessRoute } from '../../features/auth/authentication-access-route';
import { rootRoute } from '../root-route';

export const authRoutes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'auth/local',
    component: LocalAuthorizationPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'auth/local/reauthorize',
    component: LocalReauthorizationPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'auth/sign-in',
    component: HostedSignInPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'auth/no-access',
    component: NoAccessPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'auth/disabled',
    component: () => <NoAccessPage disabled />,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'auth/callback-failed',
    component: CallbackFailurePage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'auth/reauthenticate',
    component: ReauthenticationPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'auth/setup',
    component: HostedSetupPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'auth/invitation',
    component: InvitationPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'settings/authentication-access',
    component: AuthenticationAccessRoute,
  }),
];
