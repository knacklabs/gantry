import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { beforeEach, expect, it, vi } from 'vitest';

const activeSession = vi.hoisted(() => vi.fn());
const browserRoleAllowsScope = vi.hoisted(() => vi.fn());
const listProviders = vi.hoisted(() => vi.fn());
const storage = vi.hoisted(() => ({
  repositories: {
    agents: { listAgents: vi.fn(), summarizeNavigation: vi.fn() },
    agentConfigs: { getConfigVersion: vi.fn() },
    mcpServers: { listServers: vi.fn(), summarizeNavigation: vi.fn() },
    skills: { listSkills: vi.fn(), summarizeNavigation: vi.fn() },
    modelCredentials: {},
  },
}));

vi.mock('@core/control/server/routes/browser-auth.js', () => ({
  activeSession,
}));
vi.mock('@core/control/server/browser-scope-policy.js', () => ({
  browserRoleAllowsScope,
}));
vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => storage,
}));
vi.mock(
  '@core/application/model-credentials/model-credential-service.js',
  () => ({
    ModelCredentialService: class {
      list = listProviders;
    },
  }),
);

import {
  handleBrowserNavigationSummary,
  isBrowserNavigationSummaryPath,
} from '@core/control/server/routes/browser-navigation-summary.js';

function request() {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.headers = {};
  return req;
}

function response() {
  return {
    statusCode: 0,
    body: '',
    setHeader: vi.fn(),
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as unknown as ServerResponse & { body: string };
}

beforeEach(() => {
  activeSession.mockReset();
  browserRoleAllowsScope.mockReset();
  listProviders.mockReset();
  storage.repositories.agents.listAgents.mockReset();
  storage.repositories.agents.summarizeNavigation.mockReset();
  storage.repositories.agentConfigs.getConfigVersion.mockReset();
  storage.repositories.mcpServers.listServers.mockReset();
  storage.repositories.mcpServers.summarizeNavigation.mockReset();
  storage.repositories.skills.listSkills.mockReset();
  storage.repositories.skills.summarizeNavigation.mockReset();
});

it('returns one redacted, app-scoped navigation summary', async () => {
  activeSession.mockResolvedValue({ appId: 'app:one', role: 'administrator' });
  browserRoleAllowsScope.mockReturnValue(true);
  storage.repositories.agents.summarizeNavigation.mockResolvedValue({
    total: 2,
    active: 1,
    disabled: 1,
    withoutRole: 1,
  });
  storage.repositories.mcpServers.summarizeNavigation.mockResolvedValue({
    active: 1,
    disabled: 1,
  });
  storage.repositories.skills.summarizeNavigation.mockResolvedValue({
    installed: 3,
  });
  listProviders.mockResolvedValue([
    { health: 'ready' },
    { health: 'missing' },
    { health: 'disabled' },
  ]);
  const res = response();

  await handleBrowserNavigationSummary(
    request(),
    res,
    {} as never,
    '/ui/api/navigation-summary',
    { authentication: { mode: 'local' } },
  );

  expect(isBrowserNavigationSummaryPath('/ui/api/navigation-summary')).toBe(
    true,
  );
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual({
    agents: { total: 2, active: 1, disabled: 1, withoutRole: 1 },
    mcpServers: { active: 1, disabled: 1 },
    skills: { installed: 3 },
    modelProviders: { ready: 1, missing: 1, disabled: 1 },
  });
});

it('does not leak navigation counts without an administrator session', async () => {
  activeSession.mockResolvedValue({ appId: 'app:one', role: 'viewer' });
  browserRoleAllowsScope.mockReturnValue(false);
  const res = response();

  await handleBrowserNavigationSummary(
    request(),
    res,
    {} as never,
    '/ui/api/navigation-summary',
    { authentication: { mode: 'local' } },
  );

  expect(res.statusCode).toBe(403);
  expect(storage.repositories.agents.listAgents).not.toHaveBeenCalled();
});
