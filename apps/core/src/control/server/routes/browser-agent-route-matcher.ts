import { isBrowserAgentObservabilityPath } from './browser-agent-observability.js';

const AGENT_PATHS = [
  /^\/ui\/api\/agents\/([^/]+)$/,
  /^\/ui\/api\/agents\/([^/]+)\/(enable|disable)$/,
  /^\/ui\/api\/agents\/([^/]+)\/sources$/,
  /^\/ui\/api\/agents\/([^/]+)\/capabilities$/,
  /^\/ui\/api\/agents\/([^/]+)\/versions$/,
];

export function isBrowserAgentsPath(pathname: string): boolean {
  return (
    pathname === '/ui/api/agents' ||
    AGENT_PATHS.some((path) => path.test(pathname)) ||
    isBrowserAgentObservabilityPath(pathname) ||
    pathname.startsWith('/ui/api/roles') ||
    pathname === '/ui/api/agent-models'
  );
}
