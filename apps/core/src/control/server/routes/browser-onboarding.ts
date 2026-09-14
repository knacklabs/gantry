import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ControlRouteContext } from '../handler-context.js';
import { sendError } from '../http.js';
import type { BrowserOnboardingSettings } from './browser-onboarding-auth.js';
import {
  createOnboardingSetup,
  getOnboardingChannelManifest,
} from './browser-onboarding-setup.js';
import { getOnboardingStatus } from './browser-onboarding-status.js';
import { createOnboardingVerification } from './browser-onboarding-verification-create.js';
import {
  getOnboardingVerification,
  projectOnboardingVerification,
} from './browser-onboarding-verification.js';

const STATUS_PATH = '/ui/api/onboarding/status';
const MANIFEST_PATH = '/ui/api/onboarding/channel-manifest';
const VERIFICATIONS_PATH = '/ui/api/onboarding/verifications';
const SETUPS_PATH = '/ui/api/onboarding/setups';
const VERIFICATION_PATH =
  /^\/ui\/api\/onboarding\/verifications\/([^/]+)(?:\/(project))?$/;

export function isBrowserOnboardingPath(pathname: string): boolean {
  return (
    pathname === STATUS_PATH ||
    pathname === MANIFEST_PATH ||
    pathname === SETUPS_PATH ||
    pathname === VERIFICATIONS_PATH ||
    VERIFICATION_PATH.test(pathname)
  );
}

export async function handleBrowserOnboardingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
  settings: BrowserOnboardingSettings,
  url?: URL,
): Promise<boolean> {
  if (!isBrowserOnboardingPath(pathname)) return false;
  if (pathname === MANIFEST_PATH && req.method === 'GET') {
    return getOnboardingChannelManifest(req, res, settings, url);
  }
  if (pathname === SETUPS_PATH && req.method === 'POST') {
    return createOnboardingSetup(req, res, ctx, settings);
  }
  if (pathname === VERIFICATIONS_PATH && req.method === 'POST') {
    return createOnboardingVerification(req, res, settings);
  }
  const verificationMatch = VERIFICATION_PATH.exec(pathname);
  if (verificationMatch?.[2] === 'project' && req.method === 'POST') {
    return projectOnboardingVerification(
      req,
      res,
      ctx,
      settings,
      verificationMatch[1],
    );
  }
  if (verificationMatch && !verificationMatch[2] && req.method === 'GET') {
    return getOnboardingVerification(req, res, settings, verificationMatch[1]);
  }
  if (pathname === STATUS_PATH && req.method === 'GET') {
    return getOnboardingStatus(req, res, settings);
  }
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  return true;
}
