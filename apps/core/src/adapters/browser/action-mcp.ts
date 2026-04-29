import { createRequire } from 'node:module';
import path from 'node:path';

import { applyLoopbackNoProxyEnv } from '../../shared/no-proxy.js';

const require = createRequire(import.meta.url);

export const BROWSER_ACTION_MCP_PACKAGE_NAME = '@playwright/mcp';
export const BROWSER_ACTION_MCP_SERVER_NAME = 'agent_browser';

export interface BrowserActionMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function resolveBrowserActionMcpCliPath(): string {
  return path.join(
    path.dirname(
      require.resolve(`${BROWSER_ACTION_MCP_PACKAGE_NAME}/package.json`),
    ),
    'cli.js',
  );
}

export function createBrowserActionMcpServerConfig(
  cdpEndpoint: string,
): BrowserActionMcpServerConfig {
  const env: Record<string, string> = {
    PLAYWRIGHT_MCP_CDP_ENDPOINT: cdpEndpoint,
  };
  applyLoopbackNoProxyEnv(env);

  return {
    command: process.execPath,
    args: [
      resolveBrowserActionMcpCliPath(),
      '--cdp-endpoint',
      cdpEndpoint,
      '--shared-browser-context',
    ],
    env,
  };
}
