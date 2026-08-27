import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

import { isBrowserAgentsPath } from '@core/control/server/routes/browser-agents.js';

const repoRoot = path.resolve(
  new URL('../../../../../..', import.meta.url).pathname,
);
const source = fs.readFileSync(
  path.join(repoRoot, 'apps/core/src/control/server/routes/browser-agents.ts'),
  'utf8',
);

it('paginates app-scoped directory results and rejects cross-app access', () => {
  expect(isBrowserAgentsPath('/ui/api/agents')).toBe(true);
  expect(isBrowserAgentsPath('/ui/api/roles/custom-role:one')).toBe(true);
  expect(source).toContain('function page<T>');
  expect(source).toContain('Math.min(\n    100,');
  expect(source).toContain('listAgents(appId)');
  expect(source).toContain('listCustomRoles(appId)');
  expect(source).toContain('retainedAgentCounts(');
  expect(source).toContain("kind === 'built-in'");
  expect(source).toContain('retainedAgentCount: counts.get(role.id) ?? 0');
  expect(source).toContain('data: items.slice');
  expect(source).toContain('hasNext: end < total');
  expect(source).toContain("builtInRolePrompt(persona, 'full')");
  expect(source).toContain('listConversationInstalls(');
  expect(source).toContain('roleSnapshotFor(');
  expect(source).toContain('assertAvailableAgentName(');
  expect(source).toContain("roleId =\n        typeof body.roleId === 'string'");
  expect(source).toContain("const roleId = typeof body.roleId === 'string'");
  expect(source).toContain('const nameChanged = updated.name !== agent.name');
  expect(source).toContain('if (!currentConfig && !roleId)');
  expect(source).toContain('version: 1,');
  expect(source).toContain('agentNameSnapshot: updated.name');
  expect(source).toContain('currentConfigVersionId: nextConfig.id');
  expect(source).toContain('agent.appId !== appId');
  expect(source).toContain('role.appId !== appId');
  expect(source).toContain('const AGENT_SOURCES_PATH');
  expect(source).toContain('const AGENT_CAPABILITIES_PATH');
  expect(source).toContain('const AGENT_VERSIONS_PATH');
  expect(source).toContain('replaceSources({');
  expect(source).toContain('replaceCapabilities(');
  expect(source).toContain('getSources({ appId, agentId })');
  expect(source).toContain('getCapabilities({ appId, agentId })');
  expect(source).toContain("catalogKind === 'skills' || catalogKind === 'mcp'");
  expect(source).toContain("catalogKind === 'capabilities'");
  expect(source).toContain('listConfigVersions({');
  expect(source).toContain('sendJson(res, 200, { retainedAgentCount:');
});

it('requires Administrator, Origin, CSRF, and reauthentication for mutations', () => {
  expect(source).toContain('activeSession(req, mode)');
  expect(source).toContain("'agents:admin'");
  expect(source).toContain('requireBrowserMutationSession({');
  expect(source).toContain('isCanonicalBrowserOrigin(');
  expect(source).toContain(
    'isRecentlyReauthenticated(session.reauthenticatedAt)',
  );
  expect(source).toContain('ctx.syncSettingsFromProjection(appId)');
  expect(source).not.toContain('authorizeControlRequest(');
});
