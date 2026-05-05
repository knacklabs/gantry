import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDefaultRuntimeSettings,
  getRuntimeSettingsRevision,
  saveRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';

const runtimeHomes: string[] = [];

async function loadHandlers(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('MYCLAW_HOME', runtimeHome);
  return await import('@core/jobs/ipc-runtime-admin-handlers.js');
}

function readResponse(runtimeHome: string, taskId: string) {
  return JSON.parse(
    fs.readFileSync(
      path.join(
        runtimeHome,
        'data',
        'ipc',
        'main_agent',
        'task-responses',
        `task-${taskId}.json`,
      ),
      'utf-8',
    ),
  );
}

async function waitForResponse(runtimeHome: string, taskId: string) {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    const responsePath = path.join(
      runtimeHome,
      'data',
      'ipc',
      'main_agent',
      'task-responses',
      `task-${taskId}.json`,
    );
    if (fs.existsSync(responsePath)) return readResponse(runtimeHome, taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for task response: ${taskId}`);
}

function depsWithAdminTools(
  toolNames: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    ...extra,
    getToolRepository: () => ({
      listAgentToolBindings: async () =>
        toolNames.map((toolName) => ({
          status: 'active',
          toolId: `tool:${toolName}`,
        })),
    }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('@core/adapters/storage/postgres/runtime-store.js');
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('runtime admin IPC handlers', () => {
  it('returns a settings revision with full desired state for main agents', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { settingsDesiredStateHandler } = await loadHandlers(runtimeHome);

    await settingsDesiredStateHandler({
      data: { taskId: 'settings-read' },
      sourceGroup: 'main_agent',
      isMain: true,
      deps: depsWithAdminTools([
        'mcp__myclaw__settings_desired_state',
      ]) as never,
      conversationBindings: {},
      sourceGroupJids: ['tg:100'],
    });

    expect(readResponse(runtimeHome, 'settings-read')).toMatchObject({
      ok: true,
      data: {
        yaml: expect.stringContaining('defaults:'),
        revision: expect.stringMatching(/^sha256:/),
      },
    });
  });

  it('rejects full settings reads without the selected capability', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { settingsDesiredStateHandler } = await loadHandlers(runtimeHome);

    await settingsDesiredStateHandler({
      data: { taskId: 'settings-read' },
      sourceGroup: 'main_agent',
      isMain: true,
      deps: depsWithAdminTools([]) as never,
      conversationBindings: {},
      sourceGroupJids: ['tg:100'],
    });

    expect(readResponse(runtimeHome, 'settings-read')).toMatchObject({
      ok: false,
      code: 'missing_capability',
      error: expect.stringContaining('request_permission'),
    });
  });

  it('rejects global settings updates without the selected capability', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { requestSettingsUpdateHandler } = await loadHandlers(runtimeHome);

    await requestSettingsUpdateHandler({
      data: {
        taskId: 'settings-update',
        chatJid: 'tg:100',
        payload: {
          replacementYaml: 'version: 1',
          reason: 'test',
        },
      },
      sourceGroup: 'main_agent',
      isMain: true,
      deps: depsWithAdminTools([]) as never,
      conversationBindings: {},
      sourceGroupJids: ['tg:100'],
    });

    expect(readResponse(runtimeHome, 'settings-update')).toMatchObject({
      ok: false,
      code: 'missing_capability',
      error: expect.stringContaining('request_permission'),
    });
  });

  it('rejects stale settings updates before approval', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { requestSettingsUpdateHandler } = await loadHandlers(runtimeHome);

    await requestSettingsUpdateHandler({
      data: {
        taskId: 'settings-update',
        chatJid: 'tg:100',
        payload: {
          replacementYaml: 'version: 1',
          expectedRevision: 'sha256:stale',
          reason: 'test',
        },
      },
      sourceGroup: 'main_agent',
      isMain: true,
      deps: depsWithAdminTools([
        'mcp__myclaw__request_settings_update',
      ]) as never,
      conversationBindings: {},
      sourceGroupJids: ['tg:100'],
    });

    expect(readResponse(runtimeHome, 'settings-update')).toMatchObject({
      ok: false,
      code: 'stale_settings',
    });
  });

  it('shows a diff summary for approved settings updates and rejects stale approval windows', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    vi.stubEnv(
      'MYCLAW_DATABASE_URL',
      'postgres://myclaw_app:pass@localhost/myclaw',
    );
    vi.stubEnv(
      'ONECLI_DATABASE_URL',
      'postgres://onecli_app:pass@localhost/myclaw?schema=onecli',
    );
    vi.stubEnv(
      'SECRET_ENCRYPTION_KEY',
      '123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
    );
    const initial = createDefaultRuntimeSettings();
    saveRuntimeSettings(runtimeHome, initial);
    const expectedRevision = getRuntimeSettingsRevision(runtimeHome);
    const replacement = createDefaultRuntimeSettings();
    replacement.agent.defaultModel = 'sonnet';
    const replacementYaml = renderRuntimeSettingsYaml(replacement);
    const requestPermissionApproval = vi.fn(async () => {
      const concurrent = createDefaultRuntimeSettings();
      concurrent.agent.defaultModel = 'haiku';
      saveRuntimeSettings(runtimeHome, concurrent);
      return { approved: true, decidedBy: 'tg:admin' };
    });
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      getRuntimeStorage: () => ({
        ops: { getAllRegisteredGroups: vi.fn(async () => ({})) },
        repositories: {
          agents: {},
          tools: { getTool: vi.fn(async () => null) },
          skills: { getSkill: vi.fn(async () => null) },
          mcpServers: { getServer: vi.fn(async () => null) },
        },
      }),
    }));
    const { requestSettingsUpdateHandler } = await loadHandlers(runtimeHome);

    await requestSettingsUpdateHandler({
      data: {
        taskId: 'settings-update',
        chatJid: 'tg:100',
        payload: {
          replacementYaml,
          expectedRevision,
          reason: 'test',
        },
      },
      sourceGroup: 'main_agent',
      isMain: true,
      deps: {
        ...depsWithAdminTools(['mcp__myclaw__request_settings_update']),
        requestPermissionApproval,
        sendMessage: vi.fn(async () => undefined),
      } as any,
      conversationBindings: {},
      sourceGroupJids: ['tg:100'],
    });

    await expect(
      waitForResponse(runtimeHome, 'settings-update'),
    ).resolves.toMatchObject({
      ok: false,
      code: 'stale_settings',
    });
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolInput: expect.objectContaining({
          expectedRevision,
          diffSummary: expect.arrayContaining([
            expect.stringContaining('model'),
          ]),
        }),
      }),
    );
  });
});
