import { expect, it, vi } from 'vitest';

import {
  apiRequestHasSessionCookie,
  browserMutationPassesTrustBoundary,
  browserRequestHasBearer,
  browserRequestHasCredentialConflict,
  browserCsrfCookie,
  browserSessionCookie,
  csrfMatches,
  isCanonicalBrowserOrigin,
  isLoopbackHost,
  setNoStore,
} from '@core/control/server/browser-auth-boundary.js';
import { hashAuthToken } from '@core/shared/auth-tokens.js';

it('browser auth boundary > keeps browser cookie and Bearer authentication mutually exclusive', () => {
  expect(browserSessionCookie('local', 'opaque', false)).toBe(
    'gantry_session=opaque; HttpOnly; SameSite=Strict; Path=/',
  );
  expect(browserSessionCookie('hosted', 'opaque', false)).toBe(
    '__Host-gantry-session=opaque; HttpOnly; SameSite=Strict; Path=/; Secure',
  );
  expect(browserCsrfCookie('local', 'csrf', false)).toBe(
    'gantry_csrf=csrf; SameSite=Strict; Path=/',
  );
  expect(browserCsrfCookie('hosted', 'csrf', false)).toBe(
    '__Host-gantry-csrf=csrf; SameSite=Strict; Path=/; Secure',
  );

  const bearerRequest = {
    headers: { authorization: 'Bearer key' },
  } as never;
  const sessionRequest = {
    headers: { cookie: 'gantry_session=opaque' },
  } as never;
  const conflictingRequest = {
    headers: {
      authorization: 'Bearer key',
      cookie: 'gantry_session=opaque',
    },
  } as never;
  expect(browserRequestHasBearer(bearerRequest)).toBe(true);
  expect(apiRequestHasSessionCookie(sessionRequest)).toBe(true);
  expect(browserRequestHasCredentialConflict(bearerRequest)).toBe(false);
  expect(browserRequestHasCredentialConflict(sessionRequest)).toBe(false);
  expect(browserRequestHasCredentialConflict(conflictingRequest)).toBe(true);

  const csrfHash = hashAuthToken('csrf');
  const mutationRequest = {
    headers: { origin: 'https://console.example' },
  } as never;
  expect(
    isCanonicalBrowserOrigin(mutationRequest, 'https://console.example'),
  ).toBe(true);
  expect(csrfMatches('csrf', csrfHash)).toBe(true);
  expect(
    browserMutationPassesTrustBoundary(
      mutationRequest,
      'https://console.example',
      'csrf',
      csrfHash,
    ),
  ).toBe(true);
  expect(
    browserMutationPassesTrustBoundary(
      {
        headers: { ...mutationRequest.headers, authorization: 'Bearer key' },
      } as never,
      'https://console.example',
      'csrf',
      csrfHash,
    ),
  ).toBe(false);
  expect(
    browserMutationPassesTrustBoundary(
      mutationRequest,
      'https://other.example',
      'csrf',
      csrfHash,
    ),
  ).toBe(false);
  expect(
    browserMutationPassesTrustBoundary(
      mutationRequest,
      'https://console.example',
      'wrong',
      csrfHash,
    ),
  ).toBe(false);

  for (const host of ['localhost', '127.0.0.1:18789', '[::1]:18789']) {
    expect(isLoopbackHost(host)).toBe(true);
  }
  for (const host of [
    'localhost.example',
    '127.0.0.2',
    '[::2]',
    'console.example',
  ]) {
    expect(isLoopbackHost(host)).toBe(false);
  }

  const setHeader = vi.fn();
  setNoStore({ setHeader } as never);
  expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
});
