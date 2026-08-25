import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

import { isBrowserMcpServerPath } from '@core/control/server/routes/browser-mcp-servers.js';

const repoRoot = path.resolve(
  new URL('../../../../..', import.meta.url).pathname,
);

it('browser MCP facade keeps session and mutation boundary', () => {
  const source = fs.readFileSync(
    path.join(
      repoRoot,
      'apps/core/src/control/server/routes/browser-mcp-servers.ts',
    ),
    'utf8',
  );

  expect(source).toContain(
    "pathname === '/ui/api/mcp-servers' && req.method === 'GET'",
  );
  expect(
    isBrowserMcpServerPath('/ui/api/agents/agent-1/mcp-servers/server-1'),
  ).toBe(true);
  expect(source).toContain('activeSession(req, mode)');
  expect(source).toContain("'mcp:read'");
  expect(source).toContain('requireBrowserMutationSession({');
  expect(source).toContain('isCanonicalBrowserOrigin(');
  expect(source).toContain("'mcp:admin'");
  expect(source).toContain(
    'isRecentlyReauthenticated(session.reauthenticatedAt)',
  );
  expect(source).toContain('new McpServerService(');
  expect(source).toContain('ctx.syncSettingsFromProjection(appId)');
  expect(source).toContain(
    '/^\\/ui\\/api\\/mcp-servers\\/([^/]+)\\/agents\\/([^/]+)$/',
  );
  expect(source).toContain('credentialRefs: server.credentialRefs');
  expect(source).not.toContain('parsed.data.permissionPolicyIds');
  expect(source).toContain('binding: browserBinding(result)');
  expect(source).toContain('...browserEndpoint(server.config.url)');
  expect(source).toContain("endpoint.search = ''");
  expect(source).toContain("endpoint.hash = ''");
  expect(source).toContain("binding.status === 'active'");
  expect(source).not.toContain('...server };');
  expect(source).not.toContain('config: server.config');
  expect(source).not.toContain('value: secret');
});
