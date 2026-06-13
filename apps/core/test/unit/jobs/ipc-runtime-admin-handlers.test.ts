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
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  const handlers = await import('@core/jobs/ipc-runtime-admin-handlers.js');
  return {
    ...handlers,
    taskData: (
      taskId: string,
      extra: Record<string, unknown> = {},
      threadId?: string,
    ) => {
      const envelope = ipcAuth.createIpcAuthEnvelope('main_agent', threadId);
      return {
        taskId,
        appId: 'app:test',
        ...(threadId ? { authThreadId: threadId } : {}),
        responseKeyId: envelope.responseKeyId,
        ...extra,
      };
    },
  };
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
    getToolRepository: () => ({
      listAgentToolBindings: async () =>
        toolNames.map((toolName) => ({
          status: 'active',
          toolId: `tool:${toolName}`,
        })),
      getTool: async (toolId: string) => ({
        id: toolId,
        appId: 'app:test',
        status: 'active',
        selectable: true,
      }),
    }),
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('@core/adapters/storage/postgres/runtime-store.js');
  vi.doUnmock('@core/config/preflight.js');
  vi.doUnmock('@core/infrastructure/service/manager.js');
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('runtime admin IPC handlers', () => {
  it('returns a settings revision with full desired state for configured agents', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { settingsDesiredStateHandler, taskData } =
      await loadHandlers(runtimeHome);

    await settingsDesiredStateHandler({
      data: taskData('settings-read') as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([
        'mcp__gantry__settings_desired_state',
      ]) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['tg:100'],
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
      path.join(os.tmpdir(), 'gantry-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { settingsDesiredStateHandler, taskData } =
      await loadHandlers(runtimeHome);

    await settingsDesiredStateHandler({
      data: taskData('settings-read') as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([]) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['tg:100'],
    });

    expect(readResponse(runtimeHome, 'settings-read')).toMatchObject({
      ok: false,
      code: 'missing_capability',
      error: expect.stringContaining(
        'Ask a configured conversation approver to approve settings_desired_state, then choose persistent access.',
      ),
    });
  });

  it('rejects global settings updates without the selected capability', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { requestSettingsUpdateHandler, taskData } =
      await loadHandlers(runtimeHome);

    await requestSettingsUpdateHandler({
      data: taskData('settings-update', {
        chatJid: 'tg:100',
        payload: {
          replacementYaml: 'version: 1',
          reason: 'test',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([]) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['tg:100'],
    });

    expect(readResponse(runtimeHome, 'settings-update')).toMatchObject({
      ok: false,
      code: 'missing_capability',
      error: expect.stringContaining(
        'Ask a configured conversation approver to approve request_settings_update, then choose persistent access.',
      ),
    });
  });

  it('requires same-channel approval before accepting service restart', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const startService = vi.fn(() => ({ ok: true, message: 'started' }));
    vi.doMock('@core/config/preflight.js', () => ({
      validateRuntimePreflightWithStorage: vi.fn(async () => ({ ok: true })),
    }));
    vi.doMock('@core/infrastructure/service/manager.js', () => ({
      getServiceStatus: vi.fn(() => ({ kind: 'launchd' })),
      startService,
      stopService: vi.fn(() => ({ ok: true, message: 'stopped' })),
    }));
    const { serviceRestartHandler, taskData } = await loadHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: false,
      reason: 'not now',
    }));
    const sendMessage = vi.fn(async () => undefined);

    await serviceRestartHandler({
      data: taskData('restart-denied', {
        chatJid: 'tg:100',
        payload: { reason: 'test restart' },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools(['mcp__gantry__service_restart'], {
        requestPermissionApproval,
        sendMessage,
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['tg:100'],
    });

    expect(readResponse(runtimeHome, 'restart-denied')).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionPolicy: 'same_channel',
        targetJid: 'tg:100',
        toolName: 'service_restart',
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:100',
      expect.stringContaining('Rejected service restart'),
      undefined,
    );
    expect(startService).not.toHaveBeenCalled();
  });

  it('rejects stale settings updates before approval', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { requestSettingsUpdateHandler, taskData } =
      await loadHandlers(runtimeHome);

    await requestSettingsUpdateHandler({
      data: taskData('settings-update', {
        chatJid: 'tg:100',
        payload: {
          replacementYaml: 'version: 1',
          expectedRevision: 'sha256:stale',
          reason: 'test',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([
        'mcp__gantry__request_settings_update',
      ]) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['tg:100'],
    });

    expect(readResponse(runtimeHome, 'settings-update')).toMatchObject({
      ok: false,
      code: 'stale_settings',
    });
  });

  it('shows a diff summary for approved settings updates and rejects stale approval windows', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    vi.stubEnv(
      'GANTRY_DATABASE_URL',
      'postgres://gantry_app:pass@localhost/gantry',
    );
    vi.stubEnv(
      'GANTRY_MODEL_GATEWAY_DATABASE_URL',
      'postgres://model_gateway_app:pass@localhost/gantry?schema=model_gateway',
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
        ops: { getAllConversationRoutes: vi.fn(async () => ({})) },
        repositories: {
          agents: {},
          tools: {
            getTool: vi.fn(async () => null),
            listTools: vi.fn(async () => []),
          },
          skills: {
            getSkill: vi.fn(async () => null),
            listSkills: vi.fn(async () => []),
          },
          mcpServers: { getServer: vi.fn(async () => null) },
        },
      }),
    }));
    const { requestSettingsUpdateHandler, taskData } =
      await loadHandlers(runtimeHome);

    await requestSettingsUpdateHandler({
      data: taskData('settings-update', {
        chatJid: 'tg:100',
        payload: {
          replacementYaml,
          expectedRevision,
          reason: 'test',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: {
        ...depsWithAdminTools(['mcp__gantry__request_settings_update']),
        requestPermissionApproval,
        sendMessage: vi.fn(async () => undefined),
      } as any,
      conversationBindings: {},
      sourceAgentFolderJids: ['tg:100'],
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

  it('reconciles approved settings updates immediately and reloads runtime state', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    vi.stubEnv(
      'GANTRY_DATABASE_URL',
      'postgres://gantry_app:pass@localhost/gantry',
    );
    vi.stubEnv(
      'GANTRY_MODEL_GATEWAY_DATABASE_URL',
      'postgres://model_gateway_app:pass@localhost/gantry?schema=model_gateway',
    );
    vi.stubEnv(
      'SECRET_ENCRYPTION_KEY',
      '123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
    );
    const initial = createDefaultRuntimeSettings();
    saveRuntimeSettings(runtimeHome, initial);
    const expectedRevision = getRuntimeSettingsRevision(runtimeHome);
    const replacement = createDefaultRuntimeSettings();
    replacement.desiredState.authoritative = true;
    replacement.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
    };
    replacement.agents.main_agent.capabilities = [
      { id: 'browser.use', version: 'builtin' },
    ];
    const replacementYaml = renderRuntimeSettingsYaml(replacement);
    const replaceAgentCapabilityBindings = vi.fn(async () => undefined);
    const reloadRuntimeState = vi.fn(async () => undefined);
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      getRuntimeStorage: () => ({
        ops: { getAllConversationRoutes: vi.fn(async () => ({})) },
        repositories: {
          agents: {
            saveAgent: vi.fn(async () => undefined),
            listAgents: vi.fn(async () => []),
            replaceAgentCapabilityBindings,
          },
          tools: {
            getTool: vi.fn(async (id) =>
              id === 'tool:Browser'
                ? {
                    id,
                    appId: 'default',
                    name: 'Browser',
                    status: 'active',
                    selectable: true,
                  }
                : null,
            ),
            listTools: vi.fn(async () => [
              {
                id: 'tool:Browser',
                appId: 'default',
                name: 'Browser',
                status: 'active',
                selectable: true,
              },
            ]),
            saveTool: vi.fn(async () => undefined),
          },
          skills: {
            getSkill: vi.fn(async () => null),
            listSkills: vi.fn(async () => []),
          },
          mcpServers: { getServer: vi.fn(async () => null) },
        },
      }),
    }));
    const { requestSettingsUpdateHandler, taskData } =
      await loadHandlers(runtimeHome);

    await requestSettingsUpdateHandler({
      data: taskData('settings-update', {
        chatJid: 'tg:100',
        payload: {
          replacementYaml,
          expectedRevision,
          reason: 'enable test command',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: {
        ...depsWithAdminTools(['mcp__gantry__request_settings_update']),
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          decidedBy: 'tg:admin',
        })),
        sendMessage: vi.fn(async () => undefined),
        reloadRuntimeState,
      } as any,
      conversationBindings: {},
      sourceAgentFolderJids: ['tg:100'],
    });

    await expect(
      waitForResponse(runtimeHome, 'settings-update'),
    ).resolves.toMatchObject({
      ok: true,
      code: 'settings_updated',
    });
    expect(replaceAgentCapabilityBindings).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:main_agent',
        toolBindings: [
          expect.objectContaining({
            status: 'active',
            toolId: 'tool:Browser',
          }),
        ],
      }),
    );
    expect(reloadRuntimeState).toHaveBeenCalled();
  });

  it('validates and reconciles a per-agent model change via request_settings_update', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    vi.stubEnv(
      'GANTRY_DATABASE_URL',
      'postgres://gantry_app:pass@localhost/gantry',
    );
    vi.stubEnv(
      'GANTRY_MODEL_GATEWAY_DATABASE_URL',
      'postgres://model_gateway_app:pass@localhost/gantry?schema=model_gateway',
    );
    vi.stubEnv(
      'SECRET_ENCRYPTION_KEY',
      '123456789abcdefghijklmnopqrstuvwxyzABCDEFGH',
    );
    const initial = createDefaultRuntimeSettings();
    saveRuntimeSettings(runtimeHome, initial);
    const expectedRevision = getRuntimeSettingsRevision(runtimeHome);
    const replacement = createDefaultRuntimeSettings();
    replacement.desiredState.authoritative = true;
    replacement.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      // The engine is derived from the model provider; only the model is set.
      model: 'opus',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
    } as never;
    const replacementYaml = renderRuntimeSettingsYaml(replacement);
    // Round-trip proof: no engine key is rendered (engine is derived).
    expect(replacementYaml).not.toContain('agent_engine');
    const reloadRuntimeState = vi.fn(async () => undefined);
    vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
      getRuntimeStorage: () => ({
        ops: { getAllConversationRoutes: vi.fn(async () => ({})) },
        repositories: {
          agents: {
            saveAgent: vi.fn(async () => undefined),
            listAgents: vi.fn(async () => []),
            replaceAgentCapabilityBindings: vi.fn(async () => undefined),
          },
          tools: {
            getTool: vi.fn(async () => null),
            listTools: vi.fn(async () => []),
            saveTool: vi.fn(async () => undefined),
          },
          skills: {
            getSkill: vi.fn(async () => null),
            listSkills: vi.fn(async () => []),
          },
          mcpServers: { getServer: vi.fn(async () => null) },
        },
      }),
    }));
    const { requestSettingsUpdateHandler, taskData } =
      await loadHandlers(runtimeHome);

    await requestSettingsUpdateHandler({
      data: taskData('settings-update', {
        chatJid: 'tg:100',
        payload: {
          replacementYaml,
          expectedRevision,
          reason: 'set per-agent engine',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: {
        ...depsWithAdminTools(['mcp__gantry__request_settings_update']),
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          decidedBy: 'tg:admin',
        })),
        sendMessage: vi.fn(async () => undefined),
        reloadRuntimeState,
      } as any,
      conversationBindings: {},
      sourceAgentFolderJids: ['tg:100'],
    });

    await expect(
      waitForResponse(runtimeHome, 'settings-update'),
    ).resolves.toMatchObject({ ok: true, code: 'settings_updated' });
    expect(reloadRuntimeState).toHaveBeenCalled();
  });

  it('rejects an invalid model alias with a settings validation error', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-settings-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const initial = createDefaultRuntimeSettings();
    saveRuntimeSettings(runtimeHome, initial);
    const expectedRevision = getRuntimeSettingsRevision(runtimeHome);
    const replacement = createDefaultRuntimeSettings();
    replacement.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      // An unregistered alias is rejected by settings validation.
      model: 'not-a-real-model',
      bindings: {},
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
    } as never;
    const replacementYaml = renderRuntimeSettingsYaml(replacement);
    const { requestSettingsUpdateHandler, taskData } =
      await loadHandlers(runtimeHome);

    await requestSettingsUpdateHandler({
      data: taskData('settings-update', {
        chatJid: 'tg:100',
        payload: {
          replacementYaml,
          expectedRevision,
          reason: 'try incompatible engine pair',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: {
        ...depsWithAdminTools(['mcp__gantry__request_settings_update']),
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          decidedBy: 'tg:admin',
        })),
        sendMessage: vi.fn(async () => undefined),
      } as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['tg:100'],
    });

    const response = readResponse(runtimeHome, 'settings-update');
    expect(response).toMatchObject({ ok: false, code: 'invalid_settings' });
    expect(JSON.stringify(response)).toContain('not-a-real-model');
  });
});
