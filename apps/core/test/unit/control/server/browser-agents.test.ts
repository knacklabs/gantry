import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

import { isBrowserAgentsPath } from '@core/control/server/routes/browser-agents.js';

const repoRoot = path.resolve(new URL('../../../../../..', import.meta.url).pathname);
const source = fs.readFileSync(
  path.join(repoRoot, 'apps/core/src/control/server/routes/browser-agents.ts'),
  'utf8',
);

it('paginates app-scoped directory results and rejects cross-app access', () => {
  expect(isBrowserAgentsPath('/ui/api/agents')).toBe(true);
  expect(isBrowserAgentsPath('/ui/api/roles/custom-role:one')).toBe(true);
  expect(source).toContain('function page<T>');
  expect(source).toContain('Math.min(100, Math.max(1');
  expect(source).toContain('listAgents(appId)');
  expect(source).toContain('listCustomRoles(appId)');
  expect(source).toContain('agent.appId !== appId');
  expect(source).toContain('role.appId !== appId');
});

it('requires Administrator, Origin, CSRF, and reauthentication for mutations', () => {
  expect(source).toContain('activeSession(req, mode)');
  expect(source).toContain("'agents:admin'");
  expect(source).toContain('requireBrowserMutationSession({');
  expect(source).toContain('isCanonicalBrowserOrigin(');
  expect(source).toContain('isRecentlyReauthenticated(session.reauthenticatedAt)');
  expect(source).toContain('ctx.syncSettingsFromProjection(appId)');
  expect(source).not.toContain('authorizeControlRequest(');
});
