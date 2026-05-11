import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

async function loadAdminHandlers(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('MYCLAW_HOME', runtimeHome);
  const syncRuntimeSettingsFromProjection = vi.fn(async () => undefined);
  vi.doMock('@core/config/index.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('@core/config/index.js')>();
    return { ...actual, syncRuntimeSettingsFromProjection };
  });
  vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
    getRuntimeRepositories: vi.fn(() => ({})),
    getRuntimeStorage: vi.fn(() => ({ repositories: {} })),
  }));
  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  const handlers = await import('@core/jobs/ipc-admin-handlers.js');
  return {
    ...handlers,
    syncRuntimeSettingsFromProjection,
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

function depsWithAdminTools(
  toolNames: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    sendMessage: vi.fn(async () => undefined),
    registerGroup: vi.fn(async () => undefined),
    syncGroups: vi.fn(async () => undefined),
    getAvailableGroups: vi.fn(async () => []),
    writeGroupsSnapshot: vi.fn(async () => undefined),
    onSchedulerChanged: vi.fn(() => undefined),
    requestUserAnswer: vi.fn(async () => ({ response: '' })),
    opsRepository: {},
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
  vi.doUnmock('@core/config/index.js');
  vi.doUnmock('@core/adapters/storage/postgres/runtime-store.js');
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('admin IPC handlers', () => {
  it('requires same-channel approval and syncs settings after register_agent', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, syncRuntimeSettingsFromProjection, taskData } =
      await loadAdminHandlers(runtimeHome);
    const registerGroup = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));

    await adminTaskHandlers.register_agent({
      data: taskData('register-agent', {
        chatJid: 'sl:C123',
        jid: 'sl:C123',
        name: 'Ops',
        folder: 'ops_agent',
        trigger: '@Ops',
        requiresTrigger: true,
        payload: { reason: 'bind ops agent' },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools(['mcp__myclaw__register_agent'], {
        registerGroup,
        requestPermissionApproval,
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionPolicy: 'same_channel',
        targetJid: 'sl:C123',
        toolName: 'register_agent',
      }),
    );
    expect(registerGroup).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        name: 'Ops',
        folder: 'ops_agent',
        trigger: '@Ops',
      }),
    );
    expect(syncRuntimeSettingsFromProjection).toHaveBeenCalledTimes(1);
    expect(readResponse(runtimeHome, 'register-agent')).toMatchObject({
      ok: true,
      message: 'Agent "Ops" registered.',
    });
  });

  it('rejects register_agent when the requested jid is not the originating conversation', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, syncRuntimeSettingsFromProjection, taskData } =
      await loadAdminHandlers(runtimeHome);
    const registerGroup = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));

    await adminTaskHandlers.register_agent({
      data: taskData('register-other', {
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        jid: 'sl:C999',
        name: 'Other',
        folder: 'other_agent',
        trigger: '@Other',
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools(['mcp__myclaw__register_agent'], {
        registerGroup,
        requestPermissionApproval,
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(readResponse(runtimeHome, 'register-other')).toMatchObject({
      ok: false,
      code: 'forbidden',
      error: 'Agent registration can only bind the originating conversation.',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(registerGroup).not.toHaveBeenCalled();
    expect(syncRuntimeSettingsFromProjection).not.toHaveBeenCalled();
  });

  it('rejects projected browser request_permission before queuing review', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));

    await adminTaskHandlers.request_permission({
      data: taskData('request-projected-browser', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        payload: {
          permissionKind: 'tool',
          toolName: 'mcp__myclaw__browser_click',
          temporaryOnly: false,
          reason: 'need browser click',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], { requestPermissionApproval }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(
      readResponse(runtimeHome, 'request-projected-browser'),
    ).toMatchObject({
      ok: false,
      code: 'invalid_request',
      error: expect.stringContaining(
        'runtime projections, not durable capabilities',
      ),
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('rejects request_skill_proposal without signed app scope before importing a draft', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));
    const data = taskData('skill-missing-app', {
      type: 'request_skill_proposal',
      chatJid: 'sl:C123',
      payload: {
        reason: 'missing app scope',
        files: [{ path: 'SKILL.md', content: '# Test skill' }],
      },
    });
    delete data.appId;

    await adminTaskHandlers.request_skill_proposal({
      data: data as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], { requestPermissionApproval }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(readResponse(runtimeHome, 'skill-missing-app')).toMatchObject({
      ok: false,
      code: 'forbidden',
      error: 'Skill draft requests require signed app scope.',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('rejects admin capability when the selected tool belongs to another app', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));

    await adminTaskHandlers.register_agent({
      data: taskData('register-cross-app', {
        chatJid: 'sl:C123',
        jid: 'sl:C123',
        name: 'Ops',
        folder: 'ops_agent',
        trigger: '@Ops',
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools(['mcp__myclaw__register_agent'], {
        requestPermissionApproval,
        getToolRepository: () => ({
          listAgentToolBindings: async () => [
            {
              status: 'active',
              toolId: 'tool:mcp__myclaw__register_agent',
            },
          ],
          getTool: async () => ({
            appId: 'other-app',
            status: 'active',
            selectable: true,
          }),
        }),
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(readResponse(runtimeHome, 'register-cross-app')).toMatchObject({
      ok: false,
      code: 'missing_capability',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });
});
