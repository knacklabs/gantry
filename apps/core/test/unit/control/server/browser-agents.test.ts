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
const helpers = fs.readFileSync(
  path.join(
    repoRoot,
    'apps/core/src/control/server/routes/browser-agents-helpers.ts',
  ),
  'utf8',
);
const agentRouteSource = `${source}\n${helpers}`;

it('paginates app-scoped directory results and rejects cross-app access', () => {
  expect(isBrowserAgentsPath('/ui/api/agents')).toBe(true);
  expect(isBrowserAgentsPath('/ui/api/roles/custom-role:one')).toBe(true);
  expect(isBrowserAgentsPath('/ui/api/agent-models')).toBe(true);
  expect(agentRouteSource).toContain('function page<T>');
  expect(agentRouteSource).toContain('Math.min(\n    100,');
  expect(agentRouteSource).toContain('listAgents(appId)');
  expect(agentRouteSource).toContain('listCustomRoles(appId)');
  expect(agentRouteSource).toContain('retainedAgentCounts(');
  expect(agentRouteSource).toContain("kind === 'built-in'");
  expect(agentRouteSource).toContain(
    'retainedAgentCount: counts.get(role.id) ?? 0',
  );
  expect(agentRouteSource).toContain('data: items.slice');
  expect(agentRouteSource).toContain('hasNext: end < total');
  expect(agentRouteSource).toContain("builtInRolePrompt(persona, 'full')");
  expect(agentRouteSource).toContain('listConversationInstalls(');
  expect(agentRouteSource).toContain(
    'roleId: config?.roleSnapshot?.sourceRoleId ?? null',
  );
  expect(agentRouteSource).toContain('roleSnapshotFor(');
  expect(agentRouteSource).toContain('requestedModelAlias(');
  expect(agentRouteSource).toContain('validateModelAlias(');
  expect(agentRouteSource).toContain('writeAgentModelSetting({');
  expect(agentRouteSource).toContain('modelAliasSnapshot');
  expect(agentRouteSource).toContain('assertAvailableAgentName(');
  expect(agentRouteSource).toContain(
    "roleId =\n        typeof body.roleId === 'string'",
  );
  expect(agentRouteSource).toContain(
    "const roleId = typeof body.roleId === 'string'",
  );
  expect(agentRouteSource).toContain(
    'const nameChanged = updated.name !== agent.name',
  );
  expect(agentRouteSource).toContain('if (!currentConfig && !roleId)');
  expect(agentRouteSource).toContain('const nextConfigVersion =');
  expect(agentRouteSource).toContain('version: nextConfigVersion,');
  expect(agentRouteSource).toContain('agentNameSnapshot: updated.name');
  expect(agentRouteSource).toContain('currentConfigVersionId: nextConfig.id');
  expect(agentRouteSource).toContain('agent.appId !== appId');
  expect(agentRouteSource).toContain('role.appId !== appId');
  expect(agentRouteSource).toContain('const AGENT_SOURCES_PATH');
  expect(agentRouteSource).toContain('const AGENT_CAPABILITIES_PATH');
  expect(agentRouteSource).toContain('const AGENT_VERSIONS_PATH');
  expect(agentRouteSource).toContain('replaceSources({');
  expect(agentRouteSource).toContain('replaceCapabilities(');
  expect(agentRouteSource).toContain('getSources({');
  expect(agentRouteSource).toContain('getCapabilities({');
  expect(agentRouteSource).toContain('sendJson(res, 200, { sources });');
  expect(agentRouteSource).toContain(
    'capabilities: { capabilities: capabilities.capabilities },',
  );
  expect(agentRouteSource).not.toContain(
    'catalog: { skills: [], mcpServers: [] }',
  );
  expect(agentRouteSource).toContain(
    "catalogKind === 'skills' || catalogKind === 'mcp'",
  );
  expect(agentRouteSource).toContain("catalogKind === 'capabilities'");
  expect(agentRouteSource).toContain('listConfigVersions({');
  expect(agentRouteSource).toContain(
    'sendJson(res, 200, { retainedAgentCount:',
  );
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
