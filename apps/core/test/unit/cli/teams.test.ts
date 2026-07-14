import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readEnvFile } from '@core/config/env/file.js';
import { envFilePath } from '@core/config/settings/runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';

const groupsStore = vi.hoisted(() => new Map<string, any>());

vi.mock('@core/cli/runtime-group-db.js', () => ({
  openRuntimeGroupDb: async () => ({
    countConversationRoutesByJidPrefix: async (jidPrefix: string) => {
      const normalized = jidPrefix.endsWith('%')
        ? jidPrefix.slice(0, -1)
        : jidPrefix;
      return Array.from(groupsStore.keys()).filter((jid) =>
        jid.startsWith(normalized),
      ).length;
    },
    getAllConversationRoutes: async () =>
      Object.fromEntries(groupsStore.entries()),
    setConversationRoute: async (jid: string, group: any) => {
      groupsStore.set(jid, group);
    },
    getFileArtifactStore: () => undefined,
    deleteConversationRoute: async (jid: string) => {
      groupsStore.delete(jid);
    },
    deleteSession: async () => {},
    close: async () => {},
  }),
}));

const runtimeHomes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllGlobals();
  groupsStore.clear();
  while (runtimeHomes.length > 0) {
    const runtimeHome = runtimeHomes.pop();
    if (runtimeHome) fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

function mockRuntimeSecretStorage() {
  const storeRuntimeSecretInput = vi.fn(async () => undefined);
  vi.doMock('@core/cli/credentials.js', () => ({
    storeRuntimeSecretInput,
  }));
  return storeRuntimeSecretInput;
}

function makeRuntimeHome(): string {
  const runtimeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gantry-teams-test-'),
  );
  const settings = loadRuntimeSettings(runtimeHome);
  saveRuntimeSettings(runtimeHome, settings);
  runtimeHomes.push(runtimeHome);
  return runtimeHome;
}

describe('cli teams helpers', () => {
  it('validates Teams app credentials through Microsoft identity', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'graph-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { validateTeamsAppCredentials } =
      await import('@core/channels/teams-setup-discovery.js');
    const result = await validateTeamsAppCredentials({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tenantId: 'tenant-id',
    });

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
  });

  it('discovers Teams channels across paginated teams and channels', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'graph-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ id: 'team-1', displayName: 'Engineering' }],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/teams?page=2',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ id: 'team-2', displayName: 'Design' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: '19:general@thread.tacv2',
                displayName: 'General',
                membershipType: 'standard',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: '19:design@thread.tacv2',
                displayName: 'Design Critique',
                membershipType: 'private',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { listTeamsChannels } =
      await import('@core/channels/teams-setup-discovery.js');
    const result = await listTeamsChannels({
      credentials: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      limit: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.channels).toEqual([
      expect.objectContaining({
        chatJid: 'teams:19:general@thread.tacv2',
        chatTitle: 'Engineering / General',
        teamId: 'team-1',
        channelId: '19:general@thread.tacv2',
      }),
      expect.objectContaining({
        chatJid: 'teams:19:design@thread.tacv2',
        chatTitle: 'Design / Design Critique',
        teamId: 'team-2',
        channelId: '19:design@thread.tacv2',
        channelType: 'private',
      }),
    ]);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/teams?$top=10',
      expect.objectContaining({
        headers: { authorization: 'Bearer graph-token' },
      }),
    );
  });

  it('verifies manual Teams channel IDs without sending messages', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'graph-token' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'team-1', displayName: 'Engineering' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: '19:general@thread.tacv2',
            displayName: 'General',
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { verifyTeamsChannelAccess } =
      await import('@core/channels/teams-setup-discovery.js');
    const result = await verifyTeamsChannelAccess({
      credentials: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      teamId: 'team-1',
      channelId: '19:general@thread.tacv2',
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        chatJid: 'teams:19:general@thread.tacv2',
        chatTitle: 'Engineering / General',
      }),
    );
  });

  it('does not leak Teams credential values in transport failures', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValue(
        new Error('request failed with client-secret-value in body'),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { validateTeamsAppCredentials } =
      await import('@core/channels/teams-setup-discovery.js');
    const result = await validateTeamsAppCredentials({
      clientId: 'client-id',
      clientSecret: 'client-secret-value',
      tenantId: 'tenant-id',
    });

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('client-secret-value');
    expect(result.nextAction).not.toContain('client-secret-value');
  });

  it('teams connect registers a selected channel and saves credentials only after selection succeeds', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    const note = vi.fn();
    const outro = vi.fn();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'graph-token' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'graph-token' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ id: 'team-1', displayName: 'Engineering' }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: '19:general@thread.tacv2',
                displayName: 'General',
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'graph-token' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'team-1', displayName: 'Engineering' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: '19:general@thread.tacv2',
            displayName: 'General',
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note,
      password: vi.fn().mockResolvedValueOnce('client-secret'),
      text: vi
        .fn()
        .mockResolvedValueOnce('client-id')
        .mockResolvedValueOnce('tenant-id'),
      select: vi.fn(async () => 'teams:19:general@thread.tacv2'),
      outro,
      log: {
        success: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
      })),
    }));
    const storeRuntimeSecretInput = mockRuntimeSecretStorage();

    const { runTeamsConnectCommand } = await import('@core/cli/teams.js');
    const code = await runTeamsConnectCommand(runtimeHome);

    expect(code).toBe(0);
    expect(storeRuntimeSecretInput).toHaveBeenCalledWith({
      runtimeHome,
      name: 'TEAMS_CLIENT_ID',
      value: 'client-id',
      actor: 'cli:teams-connect',
    });
    expect(storeRuntimeSecretInput).toHaveBeenCalledWith({
      runtimeHome,
      name: 'TEAMS_CLIENT_SECRET',
      value: 'client-secret',
      actor: 'cli:teams-connect',
    });
    expect(storeRuntimeSecretInput).toHaveBeenCalledWith({
      runtimeHome,
      name: 'TEAMS_TENANT_ID',
      value: 'tenant-id',
      actor: 'cli:teams-connect',
    });
    expect(readEnvFile(envFilePath(runtimeHome))).not.toHaveProperty(
      'TEAMS_CLIENT_ID',
    );
    const settings = loadRuntimeSettings(runtimeHome);
    expect(settings.providers.teams.enabled).toBe(true);
    expect(settings.providerAccounts.teams_default.runtimeSecretRefs).toEqual({
      client_id: 'gantry-secret:TEAMS_CLIENT_ID',
      client_secret: 'gantry-secret:TEAMS_CLIENT_SECRET',
      tenant_id: 'gantry-secret:TEAMS_TENANT_ID',
    });
    expect(groupsStore.get('teams:19:general@thread.tacv2')).toEqual(
      expect.objectContaining({
        folder: 'main_agent',
      }),
    );
    expect(outro).toHaveBeenCalledWith(
      'Teams connected. Secret stored encrypted in Gantry.',
    );
  });

  it('teams connect cancel after credential validation does not persist credentials', async () => {
    vi.resetModules();
    const runtimeHome = makeRuntimeHome();
    const outro = vi.fn();
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'graph-token' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    vi.doMock('@clack/prompts', () => ({
      isCancel: () => false,
      note: vi.fn(),
      password: vi.fn().mockResolvedValueOnce('client-secret'),
      text: vi
        .fn()
        .mockResolvedValueOnce('client-id')
        .mockResolvedValueOnce('tenant-id'),
      select: vi.fn(async () => 'cancel'),
      outro,
      log: {
        success: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
      })),
    }));
    mockRuntimeSecretStorage();

    const { runTeamsConnectCommand } = await import('@core/cli/teams.js');
    const code = await runTeamsConnectCommand(runtimeHome);

    expect(code).toBe(1);
    expect(
      readEnvFile(envFilePath(runtimeHome)).TEAMS_CLIENT_ID,
    ).toBeUndefined();
    expect(loadRuntimeSettings(runtimeHome).providers.teams.enabled).toBe(
      false,
    );
    expect(outro).toHaveBeenCalledWith('Teams connect cancelled.');
  });
});
