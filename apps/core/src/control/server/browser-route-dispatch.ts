import type http from 'node:http';

import type { ControlRouteContext } from './handler-context.js';
import {
  browserRequestHasBearer,
  setNoStore,
} from './browser-auth-boundary.js';
import { sendControlError } from './control-server-errors.js';
import {
  handleBrowserAgentRoutes,
  isBrowserAgentsPath,
} from './routes/browser-agents.js';
import { handleBrowserAuthRoutes } from './routes/browser-auth.js';
import {
  handleBrowserChannelAccountRoutes,
  isBrowserChannelAccountsPath,
} from './routes/browser-channel-accounts.js';
import {
  handleBrowserMcpServerRoutes,
  isBrowserMcpServerPath,
} from './routes/browser-mcp-servers.js';
import { handleBrowserModelProviderRoutes } from './routes/browser-model-providers.js';
import {
  handleBrowserNavigationSummary,
  isBrowserNavigationSummaryPath,
} from './routes/browser-navigation-summary.js';
import {
  handleBrowserOnboardingRoutes,
  isBrowserOnboardingPath,
} from './routes/browser-onboarding.js';
import {
  handleBrowserPeopleRoutes,
  isBrowserPeoplePath,
} from './routes/browser-people.js';
import {
  handleBrowserRuntimeStatus,
  isBrowserRuntimeStatusPath,
} from './routes/browser-runtime-status.js';
import {
  handleBrowserSkillRoutes,
  isBrowserSkillsPath,
} from './routes/browser-skills.controller.js';

type BrowserSettings = Parameters<typeof handleBrowserAgentRoutes>[5] &
  Parameters<typeof handleBrowserChannelAccountRoutes>[4] &
  Parameters<typeof handleBrowserMcpServerRoutes>[4] &
  Parameters<typeof handleBrowserModelProviderRoutes>[3] &
  Parameters<typeof handleBrowserNavigationSummary>[4] &
  Parameters<typeof handleBrowserOnboardingRoutes>[3] &
  Parameters<typeof handleBrowserPeopleRoutes>[3] &
  Parameters<typeof handleBrowserRuntimeStatus>[4] &
  Parameters<typeof handleBrowserSkillRoutes>[4];

function isBrowserControlPath(pathname: string): boolean {
  return (
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/ui/api/auth/') ||
    isBrowserRuntimeStatusPath(pathname) ||
    isBrowserNavigationSummaryPath(pathname) ||
    isBrowserOnboardingPath(pathname) ||
    isBrowserAgentsPath(pathname) ||
    isBrowserChannelAccountsPath(pathname) ||
    isBrowserPeoplePath(pathname) ||
    pathname.startsWith('/ui/api/model-providers') ||
    isBrowserMcpServerPath(pathname) ||
    isBrowserSkillsPath(pathname)
  );
}

export async function handleBrowserControlRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  ctx: ControlRouteContext;
  url: URL;
  pathname: string;
  getSettings: () => BrowserSettings;
}): Promise<boolean> {
  if (isBrowserControlPath(input.pathname)) {
    setNoStore(input.res);
    if (browserRequestHasBearer(input.req)) {
      sendControlError(
        input.res,
        401,
        'UNAUTHORIZED',
        'Bearer credentials are not accepted for browser routes.',
      );
      return true;
    }
  }
  const settings = input.getSettings();
  if (
    isBrowserOnboardingPath(input.pathname) &&
    (await handleBrowserOnboardingRoutes(
      input.req,
      input.res,
      input.pathname,
      settings,
    ))
  )
    return true;
  if (
    isBrowserRuntimeStatusPath(input.pathname) &&
    (await handleBrowserRuntimeStatus(
      input.req,
      input.res,
      input.ctx,
      input.pathname,
      settings,
    ))
  )
    return true;
  if (
    isBrowserNavigationSummaryPath(input.pathname) &&
    (await handleBrowserNavigationSummary(
      input.req,
      input.res,
      input.ctx,
      input.pathname,
      settings,
    ))
  )
    return true;
  if (
    isBrowserAgentsPath(input.pathname) &&
    (await handleBrowserAgentRoutes(
      input.req,
      input.res,
      input.ctx,
      input.pathname,
      input.url,
      settings,
    ))
  )
    return true;
  if (
    isBrowserChannelAccountsPath(input.pathname) &&
    (await handleBrowserChannelAccountRoutes(
      input.req,
      input.res,
      input.ctx,
      input.pathname,
      settings,
    ))
  )
    return true;
  if (
    isBrowserPeoplePath(input.pathname) &&
    (await handleBrowserPeopleRoutes(
      input.req,
      input.res,
      input.pathname,
      settings,
    ))
  )
    return true;
  if (
    isBrowserMcpServerPath(input.pathname) &&
    (await handleBrowserMcpServerRoutes(
      input.req,
      input.res,
      input.ctx,
      input.pathname,
      settings,
    ))
  )
    return true;
  if (
    input.pathname.startsWith('/ui/api/model-providers') &&
    (await handleBrowserModelProviderRoutes(
      input.req,
      input.res,
      input.pathname,
      settings,
    ))
  )
    return true;
  if (
    await handleBrowserSkillRoutes(
      input.req,
      input.res,
      input.ctx,
      input.pathname,
      settings,
    )
  )
    return true;
  if (
    await handleBrowserAuthRoutes(
      input.req,
      input.res,
      input.ctx,
      input.pathname,
    )
  )
    return true;
  if (input.pathname.startsWith('/ui/api/auth/')) {
    sendControlError(input.res, 404, 'NOT_FOUND', 'Route not found');
    return true;
  }
  return false;
}
