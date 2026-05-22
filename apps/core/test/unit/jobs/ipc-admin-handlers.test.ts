import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

async function loadAdminHandlers(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
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
    runApprovedCommand: vi.fn(async () => undefined),
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
  it('rejects direct request_permission semantic capability requests outside propose_capability', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));

    await adminTaskHandlers.request_permission({
      data: taskData('direct-capability-request', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        payload: {
          permissionKind: 'tool',
          capabilityId: 'google.sheets.write',
          temporaryOnly: false,
          reason: 'write leads',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        requestPermissionApproval,
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(
      readResponse(runtimeHome, 'direct-capability-request'),
    ).toMatchObject({
      ok: false,
      code: 'invalid_request',
      error:
        'Capability requests must use propose_capability, not request_permission.',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('requires same-channel approval and syncs settings after register_agent', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
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
      deps: depsWithAdminTools(['mcp__gantry__register_agent'], {
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
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
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
      deps: depsWithAdminTools(['mcp__gantry__register_agent'], {
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
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
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
          toolName: 'mcp__gantry__browser_act',
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

  it('rejects a generic capability request when the job declares a local CLI implementation', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));

    await adminTaskHandlers.request_permission({
      data: taskData('request-generic-sheets', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        jobId: 'job-1',
        payload: {
          permissionKind: 'tool',
          capabilityRequestSource: 'propose_capability',
          capabilityId: 'google.sheets.write',
          capabilityDisplayName: 'Google Sheets write',
          temporaryOnly: false,
          reason: 'write leads',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        requestPermissionApproval,
        opsRepository: {
          getJobById: vi.fn(async () => ({
            capability_requirements: [
              {
                capabilityId: 'google.sheets.write',
                reason: 'write leads',
                implementation: {
                  kind: 'local_cli',
                  name: 'gog',
                  executablePath: '/usr/local/bin/gog',
                  executableVersion: 'v0.9.0',
                  executableHash: 'sha256:abc123',
                  commandTemplate:
                    '/usr/local/bin/gog sheets append <sheet_id> ...',
                },
              },
            ],
          })),
        },
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(readResponse(runtimeHome, 'request-generic-sheets')).toMatchObject({
      ok: false,
      code: 'wrong_capability_lane',
      error: expect.stringContaining('Google Sheets write using gog'),
    });
    expect(readResponse(runtimeHome, 'request-generic-sheets').error).toContain(
      'RunCommand(/usr/local/bin/gog sheets append *)',
    );
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('rejects semantic toolName requests when the job declares a local CLI implementation', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));

    await adminTaskHandlers.request_permission({
      data: taskData('request-semantic-toolname-sheets', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        jobId: 'job-1',
        payload: {
          permissionKind: 'tool',
          toolName: 'capability:google.sheets.write',
          temporaryOnly: false,
          reason: 'write leads',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        requestPermissionApproval,
        opsRepository: {
          getJobById: vi.fn(async () => ({
            capability_requirements: [
              {
                capabilityId: 'google.sheets.write',
                reason: 'write leads',
                implementation: {
                  kind: 'local_cli',
                  name: 'gog',
                  executablePath: '/usr/local/bin/gog',
                  executableVersion: 'v0.9.0',
                  executableHash: 'sha256:abc123',
                  commandTemplate:
                    '/usr/local/bin/gog sheets append <sheet_id> ...',
                },
              },
            ],
          })),
        },
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(
      readResponse(runtimeHome, 'request-semantic-toolname-sheets'),
    ).toMatchObject({
      ok: false,
      code: 'wrong_capability_lane',
      error: expect.stringContaining(
        'RunCommand(/usr/local/bin/gog sheets append *)',
      ),
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('rejects semantic toolNames requests when the job declares a local CLI implementation', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));

    await adminTaskHandlers.request_permission({
      data: taskData('request-semantic-toolnames-sheets', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        jobId: 'job-1',
        payload: {
          permissionKind: 'tool',
          toolNames: ['capability:google.sheets.write'],
          temporaryOnly: false,
          reason: 'write leads',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        requestPermissionApproval,
        opsRepository: {
          getJobById: vi.fn(async () => ({
            capability_requirements: [
              {
                capabilityId: 'google.sheets.write',
                reason: 'write leads',
                implementation: {
                  kind: 'local_cli',
                  name: 'gog',
                  executablePath: '/usr/local/bin/gog',
                  executableVersion: 'v0.9.0',
                  executableHash: 'sha256:abc123',
                  commandTemplate:
                    '/usr/local/bin/gog sheets append <sheet_id> ...',
                },
              },
            ],
          })),
        },
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(
      readResponse(runtimeHome, 'request-semantic-toolnames-sheets'),
    ).toMatchObject({
      ok: false,
      code: 'wrong_capability_lane',
      error: expect.stringContaining(
        'RunCommand(/usr/local/bin/gog sheets append *)',
      ),
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('rejects local CLI semantic proposals for a job until the scoped RunCommand rule is requested', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));

    await adminTaskHandlers.request_permission({
      data: taskData('request-local-cli-proposal-sheets', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        jobId: 'job-1',
        payload: {
          permissionKind: 'tool',
          capabilityRequestSource: 'propose_capability',
          capabilityId: 'google.sheets.write',
          capabilityDisplayName: 'Google Sheets write using gog',
          credentialSource: 'local_cli',
          executablePath: '/usr/local/bin/gog',
          executableVersion: '1.2.3',
          executableHash: 'sha256:gog',
          commandTemplates: ['/usr/local/bin/gog sheets append *'],
          temporaryOnly: false,
          reason: 'write leads',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        requestPermissionApproval,
        opsRepository: {
          getJobById: vi.fn(async () => ({
            capability_requirements: [
              {
                capabilityId: 'google.sheets.write',
                reason: 'write leads',
                implementation: {
                  kind: 'local_cli',
                  name: 'gog',
                  executablePath: '/usr/local/bin/gog',
                  executableVersion: 'v0.9.0',
                  executableHash: 'sha256:abc123',
                  commandTemplate:
                    '/usr/local/bin/gog sheets append <sheet_id> ...',
                },
              },
            ],
          })),
        },
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(
      readResponse(runtimeHome, 'request-local-cli-proposal-sheets'),
    ).toMatchObject({
      ok: false,
      code: 'wrong_capability_lane',
      error: expect.stringContaining(
        'RunCommand(/usr/local/bin/gog sheets append *)',
      ),
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('coalesces duplicate pending request_permission reviews', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    let resolveApproval:
      | ((value: { approved: false; reason: string }) => void)
      | undefined;
    const requestPermissionApproval = vi.fn(
      () =>
        new Promise<{ approved: false; reason: string }>((resolve) => {
          resolveApproval = resolve;
        }),
    );

    const baseTask = {
      type: 'request_permission',
      chatJid: 'sl:C123',
      payload: {
        permissionKind: 'tool',
        toolName: 'Bash',
        rule: '/usr/local/bin/gog sheets append *',
        temporaryOnly: false,
        reason: 'write leads with gog',
      },
    };
    await adminTaskHandlers.request_permission({
      data: taskData('request-gog-1', baseTask) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], { requestPermissionApproval }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });
    await adminTaskHandlers.request_permission({
      data: taskData('request-gog-2', baseTask) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], { requestPermissionApproval }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
    expect(readResponse(runtimeHome, 'request-gog-1')).toMatchObject({
      ok: true,
      code: 'capability_request_recorded',
    });
    expect(readResponse(runtimeHome, 'request-gog-2')).toMatchObject({
      ok: true,
      code: 'capability_request_already_pending',
    });

    resolveApproval?.({ approved: false, reason: 'test complete' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('coalesces duplicate pending skill install command reviews', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    let resolveApproval:
      | ((value: { approved: false; reason: string }) => void)
      | undefined;
    const requestPermissionApproval = vi.fn(
      () =>
        new Promise<{ approved: false; reason: string }>((resolve) => {
          resolveApproval = resolve;
        }),
    );

    const baseTask = {
      type: 'request_skill_install',
      chatJid: 'sl:C123',
      payload: {
        reason: 'install catalog skill',
        installCommandArgv: ['npx', '-y', '@skills-sh/cli', 'install', 'x'],
      },
    };
    await adminTaskHandlers.request_skill_install({
      data: taskData('skill-command-1', baseTask) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], { requestPermissionApproval }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });
    await adminTaskHandlers.request_skill_install({
      data: taskData('skill-command-2', baseTask) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], { requestPermissionApproval }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
    expect(readResponse(runtimeHome, 'skill-command-2')).toMatchObject({
      ok: true,
      code: 'skill_install_already_pending',
    });

    resolveApproval?.({ approved: false, reason: 'test complete' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readResponse(runtimeHome, 'skill-command-1')).toMatchObject({
      ok: false,
      code: 'permission_denied',
    });
  });

  it('rejects request_skill_proposal without signed app scope before importing a draft', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
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

  it('rejects skill install requests that mix package files with installer commands', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));

    await adminTaskHandlers.request_skill_install({
      data: taskData('skill-mixed-install', {
        type: 'request_skill_install',
        chatJid: 'sl:C123',
        payload: {
          reason: 'Install a catalog skill.',
          files: [{ path: 'SKILL.md', content: '# Test skill' }],
          installCommandArgv: ['npx', '-y', '@skills-sh/cli', 'install', 'x'],
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], { requestPermissionApproval }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(readResponse(runtimeHome, 'skill-mixed-install')).toMatchObject({
      ok: false,
      code: 'invalid_request',
      error:
        'Skill install requests must use either files or installCommandArgv, not both.',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('rejects admin capability when the selected tool belongs to another app', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
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
      deps: depsWithAdminTools(['mcp__gantry__register_agent'], {
        requestPermissionApproval,
        getToolRepository: () => ({
          listAgentToolBindings: async () => [
            {
              status: 'active',
              toolId: 'tool:mcp__gantry__register_agent',
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
