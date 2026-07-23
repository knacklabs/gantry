import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHomes: string[] = [];

async function loadAdminHandlers(runtimeHome: string) {
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  const syncRuntimeSettingsFromProjection = vi.fn(async () => undefined);
  const pendingAccessRequests = {
    insertPending: vi.fn(async () => undefined),
    markResolved: vi.fn(async () => undefined),
    countPendingAccessRequests: vi.fn(async () => 0),
  };
  vi.doMock('@core/config/index.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('@core/config/index.js')>();
    return { ...actual, syncRuntimeSettingsFromProjection };
  });
  vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
    getRuntimeRepositories: vi.fn(() => ({})),
    getRuntimeStorage: vi.fn(() => ({
      repositories: { pendingAccessRequests },
    })),
  }));
  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  const handlers = await import('@core/jobs/ipc-admin-handlers.js');
  return {
    ...handlers,
    pendingAccessRequests,
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
  it('keeps group sync failures out of the agent-facing response', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const rawReason = 'RAW_GROUP_SYNC_SENTINEL: provider cursor exploded';

    await adminTaskHandlers.refresh_groups({
      data: taskData('group-sync-failure') as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        syncGroups: vi.fn(async () => {
          throw new Error(rawReason);
        }),
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    const response = readResponse(runtimeHome, 'group-sync-failure');
    expect(response).toMatchObject({
      ok: false,
      error:
        'I could not refresh the conversation list. Explain this in plain language and say you can try again after the sync issue is fixed.',
      code: 'internal_error',
    });
    expect(JSON.stringify(response)).not.toContain(rawReason);
  });

  it('keeps dependency review failures out of the chat message', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const rawReason =
      'RAW_DEPENDENCY_REVIEW_SENTINEL: npm install secret-package failed';
    const deps = depsWithAdminTools([], {
      requestPermissionApproval: vi.fn(async () => {
        throw new Error(rawReason);
      }),
    });

    await adminTaskHandlers.request_skill_dependency_install({
      data: taskData('dependency-review-failure', {
        type: 'request_skill_dependency_install',
        chatJid: 'sl:C123',
        payload: {
          ecosystem: 'npm',
          packages: ['secret-package'],
          reason: 'Install the required dependency.',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: deps as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    await vi.waitFor(() => expect(deps.sendMessage).toHaveBeenCalledTimes(1));
    const message = String(deps.sendMessage.mock.calls[0]?.[1]);
    expect(message).toBe(
      'I could not finish that setup request. I left the current setup unchanged; try again after the setup issue is fixed.',
    );
    expect(message).not.toContain(rawReason);
    expect(message).not.toContain('secret-package');
    expect(message).not.toContain('npm install');
  });

  it('rejects remote MCP server requests before approval because runtime cannot project them yet', async () => {
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

    await adminTaskHandlers.request_mcp_server({
      data: taskData('remote-mcp', {
        type: 'request_mcp_server',
        chatJid: 'sl:C123',
        targetJid: 'sl:C123',
        payload: {
          name: 'github',
          transport: 'http',
          origin: 'https://mcp.example.test/github',
          reason: 'Use the github MCP server.',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        requestPermissionApproval,
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(readResponse(runtimeHome, 'remote-mcp')).toMatchObject({
      ok: false,
      code: 'invalid_request',
      error:
        'request_mcp_server supports only stdio_template servers until Gantry has a DNS-pinned remote MCP transport.',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('routes denied MCP reviews through the originating provider account', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: false,
      reason: 'not today',
    }));
    const sendMessage = vi.fn(async () => undefined);

    await adminTaskHandlers.request_mcp_server({
      data: taskData(
        'mcp-provider-account',
        {
          type: 'request_mcp_server',
          chatJid: 'sl:C123',
          targetJid: 'sl:C123',
          providerAccountId: 'slack_secondary',
          payload: {
            name: 'github',
            transport: 'stdio_template',
            templateId: 'npx-package',
            sandboxProfileId: 'mcp-stdio',
            args: ['@modelcontextprotocol/server-github'],
            reason: 'Use the GitHub MCP source.',
          },
        },
        '171234.567',
      ) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        requestPermissionApproval,
        sendMessage,
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        targetJid: 'sl:C123',
        threadId: '171234.567',
        providerAccountId: 'slack_secondary',
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.stringContaining('github'),
      {
        threadId: '171234.567',
        providerAccountId: 'slack_secondary',
      },
    );
  });

  it('rejects direct request_permission semantic capability requests outside request_access', async () => {
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
          capabilityId: 'acme.records.append',
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
        'Capability access must use request_access target.kind=capability, not direct request_permission.',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('rejects request_permission semantic proposals without a reviewed definition', async () => {
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
      data: taskData('forged-capability-proposal', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        payload: {
          permissionKind: 'tool',
          capabilityRequestSource: 'request_access',
          capabilityId: 'acme.records.append',
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
      readResponse(runtimeHome, 'forged-capability-proposal'),
    ).toMatchObject({
      ok: false,
      code: 'invalid_request',
      error:
        'Capability access requires an active reviewed capability catalog entry. Request the reviewed capability with request_access target.kind=capability.',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('accepts request_access skill action capabilities from selected skill definitions', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: false,
      reason: 'not now',
    }));
    const now = '2026-06-02T00:00:00.000Z';

    await adminTaskHandlers.request_permission({
      data: taskData('selected-skill-capability-request', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        payload: {
          permissionKind: 'tool',
          capabilityRequestSource: 'request_access',
          capabilityId: 'skill.publisher.publish',
          capabilityDisplayName: 'Publisher publish',
          temporaryOnly: false,
          reason: 'publish prepared content',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        requestPermissionApproval,
        getToolRepository: () => ({
          listTools: vi.fn(async () => []),
        }),
        getSkillRepository: () => ({
          listAgentSkillBindings: vi.fn(async () => [
            {
              id: 'binding:publisher',
              appId: 'app:test',
              agentId: 'agent:main_agent',
              skillId: 'skill:publisher',
              status: 'active',
              createdAt: now,
              updatedAt: now,
            },
          ]),
          getSkill: vi.fn(async () => ({
            id: 'skill:publisher',
            appId: 'app:test',
            name: 'publisher',
            source: 'admin_uploaded',
            status: 'installed',
            promptRefs: [],
            toolIds: [],
            workflowRefs: [],
            actionPermissions: [
              {
                id: 'publish',
                capabilityId: 'skill.publisher.publish',
                displayName: 'Publisher publish',
                risk: 'write',
                can: 'Publish prepared content through the selected skill.',
                cannot: 'Use unrelated skills or credentials.',
                requiredEnvVars: [],
                commandTemplates: ['skills/publisher/publish.py *'],
              },
            ],
            createdAt: now,
            updatedAt: now,
          })),
        }),
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      readResponse(runtimeHome, 'selected-skill-capability-request'),
    ).toMatchObject({
      ok: true,
      code: 'capability_request_recorded',
    });
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'request_permission',
        toolInput: expect.objectContaining({
          capabilityId: 'skill.publisher.publish',
        }),
        // Guards the "Always Allow" fix: the trusted capability definition must
        // be attached so decisionForMode can validate the capability:<id> rule
        // (without it, persistent approval was rejected as "unknown capability").
        semanticCapabilityDefinitions: expect.objectContaining({
          'skill.publisher.publish': expect.objectContaining({
            capabilityId: 'skill.publisher.publish',
          }),
        }),
        suggestions: [
          expect.objectContaining({
            type: 'addRules',
            rules: [{ toolName: 'capability:skill.publisher.publish' }],
          }),
        ],
        decisionOptions: ['allow_once', 'allow_persistent_rule', 'cancel'],
      }),
    );
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
      data: taskData('request-generic-records', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        jobId: 'job-1',
        payload: {
          permissionKind: 'tool',
          capabilityRequestSource: 'request_access',
          capabilityId: 'acme.records.append',
          capabilityDisplayName: 'Acme records append',
          semanticCapabilityDefinition: {
            capabilityId: 'acme.records.append',
            displayName: 'Acme records append',
            category: 'Acme Records',
            risk: 'write',
            can: 'Append rows through a configured adapter.',
            cannot: 'Receive raw credentials.',
            credentialSource: 'configured_access',
            implementationBindings: [
              { kind: 'adapter', adapterRef: 'adapter:google-records' },
            ],
          },
          temporaryOnly: false,
          reason: 'write leads',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        requestPermissionApproval,
        opsRepository: {
          getJobById: vi.fn(async () => ({
            access_requirements: [
              {
                target: {
                  kind: 'capability',
                  capabilityId: 'acme.records.append',
                  implementation: {
                    kind: 'local_cli',
                    name: 'acme',
                    executablePath: '/usr/local/bin/acme',
                    executableVersion: 'v0.9.0',
                    executableHash: 'sha256:abc123',
                    commandTemplate:
                      '/usr/local/bin/acme records append <sheet_id> ...',
                  },
                },
                reason: 'write leads',
              },
            ],
          })),
        },
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(readResponse(runtimeHome, 'request-generic-records')).toMatchObject({
      ok: false,
      code: 'invalid_request',
      error:
        'Capability definitions are host-owned catalog metadata and cannot be supplied in request_permission input.',
    });
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
      data: taskData('request-semantic-toolname-records', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        jobId: 'job-1',
        payload: {
          permissionKind: 'tool',
          toolName: 'capability:acme.records.append',
          temporaryOnly: false,
          reason: 'write leads',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        requestPermissionApproval,
        opsRepository: {
          getJobById: vi.fn(async () => ({
            access_requirements: [
              {
                target: {
                  kind: 'capability',
                  capabilityId: 'acme.records.append',
                  implementation: {
                    kind: 'local_cli',
                    name: 'acme',
                    executablePath: '/usr/local/bin/acme',
                    executableVersion: 'v0.9.0',
                    executableHash: 'sha256:abc123',
                    commandTemplate:
                      '/usr/local/bin/acme records append <sheet_id> ...',
                  },
                },
                reason: 'write leads',
              },
            ],
          })),
        },
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(
      readResponse(runtimeHome, 'request-semantic-toolname-records'),
    ).toMatchObject({
      ok: false,
      code: 'wrong_capability_lane',
      error: expect.stringContaining(
        'RunCommand(/usr/local/bin/acme records append *)',
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
      data: taskData('request-semantic-toolnames-records', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        jobId: 'job-1',
        payload: {
          permissionKind: 'tool',
          toolNames: ['capability:acme.records.append'],
          temporaryOnly: false,
          reason: 'write leads',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        requestPermissionApproval,
        opsRepository: {
          getJobById: vi.fn(async () => ({
            access_requirements: [
              {
                target: {
                  kind: 'capability',
                  capabilityId: 'acme.records.append',
                  implementation: {
                    kind: 'local_cli',
                    name: 'acme',
                    executablePath: '/usr/local/bin/acme',
                    executableVersion: 'v0.9.0',
                    executableHash: 'sha256:abc123',
                    commandTemplate:
                      '/usr/local/bin/acme records append <sheet_id> ...',
                  },
                },
                reason: 'write leads',
              },
            ],
          })),
        },
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(
      readResponse(runtimeHome, 'request-semantic-toolnames-records'),
    ).toMatchObject({
      ok: false,
      code: 'wrong_capability_lane',
      error: expect.stringContaining(
        'RunCommand(/usr/local/bin/acme records append *)',
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
      data: taskData('request-local-cli-proposal-records', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        jobId: 'job-1',
        payload: {
          permissionKind: 'tool',
          capabilityRequestSource: 'request_access',
          capabilityId: 'acme.records.append',
          capabilityDisplayName: 'Acme records append using acme',
          credentialSource: 'local_cli',
          executablePath: '/usr/local/bin/acme',
          executableVersion: '1.2.3',
          executableHash: 'sha256:acme',
          commandTemplates: ['/usr/local/bin/acme records append *'],
          temporaryOnly: false,
          reason: 'write leads',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        requestPermissionApproval,
        opsRepository: {
          getJobById: vi.fn(async () => ({
            access_requirements: [
              {
                target: {
                  kind: 'capability',
                  capabilityId: 'acme.records.append',
                  implementation: {
                    kind: 'local_cli',
                    name: 'acme',
                    executablePath: '/usr/local/bin/acme',
                    executableVersion: 'v0.9.0',
                    executableHash: 'sha256:abc123',
                    commandTemplate:
                      '/usr/local/bin/acme records append <sheet_id> ...',
                  },
                },
                reason: 'write leads',
              },
            ],
          })),
        },
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(
      readResponse(runtimeHome, 'request-local-cli-proposal-records'),
    ).toMatchObject({
      ok: false,
      code: 'wrong_capability_lane',
      error: expect.stringContaining(
        'RunCommand(/usr/local/bin/acme records append *)',
      ),
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
  });

  it('coalesces duplicate pending request_permission reviews', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, pendingAccessRequests, taskData } =
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
        rule: '/usr/local/bin/acme records append *',
        temporaryOnly: false,
        reason: 'write leads with acme',
      },
    };
    await adminTaskHandlers.request_permission({
      data: taskData('request-acme-1', baseTask) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], { requestPermissionApproval }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });
    await adminTaskHandlers.request_permission({
      data: taskData('request-acme-2', baseTask) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], { requestPermissionApproval }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
    expect(pendingAccessRequests.insertPending).toHaveBeenCalledTimes(1);
    expect(pendingAccessRequests.insertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          activation: 'future_config_version',
          effect: 'persistent_rule_when_always_allowed',
          requestKind: 'Permission',
          requestTool: 'request_permission',
        },
      }),
    );
    const insertedRequest = pendingAccessRequests.insertPending.mock
      .calls[0]?.[0] as { target?: unknown; reason?: unknown } | undefined;
    expect(JSON.stringify(insertedRequest)).not.toContain(
      '/usr/local/bin/acme records append',
    );
    expect(insertedRequest).not.toHaveProperty('reason');
    expect(readResponse(runtimeHome, 'request-acme-1')).toMatchObject({
      ok: true,
      code: 'capability_request_recorded',
    });
    expect(readResponse(runtimeHome, 'request-acme-2')).toMatchObject({
      ok: true,
      code: 'capability_request_already_pending',
    });

    resolveApproval?.({ approved: false, reason: 'test complete' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingAccessRequests.markResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        resolution: 'denied',
      }),
    );
  });

  it('rechecks setup-paused jobs after persistent request_access approvals', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const tools = new Map<string, Record<string, unknown>>();
    const bindings: Array<Record<string, unknown>> = [];
    const toolRepository = {
      listTools: vi.fn(async () => [...tools.values()]),
      getTool: vi.fn(async (toolId: string) => tools.get(toolId)),
      saveTool: vi.fn(async (tool: Record<string, unknown>) => {
        tools.set(String(tool.id), tool);
      }),
      listAgentToolBindings: vi.fn(async () => bindings),
      saveAgentToolBinding: vi.fn(async (binding: Record<string, unknown>) => {
        bindings.push(binding);
      }),
    };
    let job = {
      id: 'job-1',
      name: 'Sheet append job',
      workspace_key: 'main_agent',
      status: 'paused',
      pause_reason: 'Setup required',
      next_run: null,
      execution_context: {
        conversationJid: 'sl:C123',
        threadId: null,
        workspaceKey: 'main_agent',
      },
      access_requirements: [
        {
          target: {
            kind: 'tool_rule',
            rule: 'RunCommand(npm test *)',
          },
          reason: 'Run tests before updating the sheet.',
        },
      ],
      setup_state: {
        state: 'missing_capability',
        checked_at: '2026-06-02T00:00:00.000Z',
        fingerprint: 'old',
        blockers: [
          {
            state: 'missing_capability',
            requirementType: 'tool',
            requirementId: 'RunCommand(npm test *)',
            message: 'Needs command access.',
            nextAction: 'request_access ...',
          },
        ],
      },
    };
    const updateJob = vi.fn(async (_jobId: string, updates: object) => {
      job = { ...job, ...updates };
    });
    const onSchedulerChanged = vi.fn();
    const sendMessage = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      mode: 'allow_persistent_rule',
      decidedBy: 'U_APPROVER',
      decisionClassification: 'user_permanent',
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'RunCommand', ruleContent: 'npm test *' }],
        },
      ],
    }));

    await adminTaskHandlers.request_permission({
      data: taskData('request-command-access', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        jobId: 'job-1',
        payload: {
          permissionKind: 'tool',
          capabilityRequestSource: 'request_access',
          toolName: 'RunCommand',
          rule: 'npm test *',
          temporaryOnly: false,
          reason: 'Run tests before updating the sheet.',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        sendMessage,
        requestPermissionApproval,
        getToolRepository: () => toolRepository,
        mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
        onSchedulerChanged,
        opsRepository: {
          getJobById: vi.fn(async () => job),
          updateJob,
        },
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    await vi.waitFor(() => {
      expect(updateJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          status: 'active',
          pause_reason: null,
          setup_state: expect.objectContaining({ state: 'ready' }),
        }),
      );
    });
    expect(onSchedulerChanged).toHaveBeenCalledWith('job-1');
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.stringContaining('Job resumed: Sheet append job.'),
      undefined,
    );
  });

  it('applies temporary request_access run_command approvals to current-run live rules', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'U_APPROVER',
      decisionClassification: 'user_temporary',
    }));
    const deps = depsWithAdminTools([], { requestPermissionApproval });
    const ipcBaseDir = path.join(runtimeHome, 'data', 'ipc');

    await adminTaskHandlers.request_permission({
      data: taskData('temp-run-command', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        runHandle: 'agent-run-temp',
        payload: {
          permissionKind: 'tool',
          capabilityRequestSource: 'request_access',
          toolName: 'RunCommand',
          rule: 'npm test *',
          temporaryOnly: true,
          reason: 'run the focused test once',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: deps as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
      ipcBaseDir,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            ipcBaseDir,
            'main_agent',
            'live-tool-rules',
            'agent-run-temp.json',
          ),
          'utf-8',
        ),
      ),
    ).toEqual(['RunCommand(npm test *)']);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.stringContaining('for this run'),
      undefined,
    );
  });

  it('audits malformed mcp_call_tool requests before rejecting them', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, taskData } =
      await loadAdminHandlers(runtimeHome);
    const appendAuditEvent = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await adminTaskHandlers.mcp_call_tool({
      data: taskData('bad-mcp-call', {
        type: 'mcp_call_tool',
        chatJid: 'sl:C123',
        runId: 'agent-run-1',
        runHandle: 'runner-handle-1',
        payload: {
          toolName: 'create_issue',
          arguments: 'token=secret-value',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: depsWithAdminTools([], {
        getMcpServerRepository: () =>
          ({
            appendAuditEvent,
          }) as never,
        publishRuntimeEvent,
      }) as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    expect(readResponse(runtimeHome, 'bad-mcp-call')).toMatchObject({
      ok: false,
      code: 'invalid_request',
      error: 'mcp_call_tool arguments must be a JSON object when provided.',
    });
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        agentId: 'agent:main_agent',
        eventType: 'tool_activity',
        actorId: 'mcp-tool-handler',
        metadata: expect.objectContaining({
          toolName: 'create_issue',
          resultClass: 'invalid_request',
          runHandle: 'runner-handle-1',
          missingFields: ['serverName'],
          argumentSummary: expect.objectContaining({
            kind: 'string',
            keyCount: 0,
          }),
        }),
      }),
    );
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        agentId: 'agent:main_agent',
        runId: 'agent-run-1',
        actor: 'mcp-tool-handler',
        payload: expect.objectContaining({
          resultClass: 'invalid_request',
          toolName: 'create_issue',
        }),
      }),
    );
    expect(JSON.stringify(appendAuditEvent.mock.calls)).not.toContain(
      'secret-value',
    );
    expect(JSON.stringify(publishRuntimeEvent.mock.calls)).not.toContain(
      'secret-value',
    );
  });

  it('does not resolve pending access as approved without an approving principal', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-admin-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { adminTaskHandlers, pendingAccessRequests, taskData } =
      await loadAdminHandlers(runtimeHome);
    const requestPermissionApproval = vi.fn(async () => ({ approved: true }));
    const deps = depsWithAdminTools([], { requestPermissionApproval });

    await adminTaskHandlers.request_permission({
      data: taskData('request-acme-missing-approver', {
        type: 'request_permission',
        chatJid: 'sl:C123',
        payload: {
          permissionKind: 'tool',
          toolName: 'Bash',
          rule: '/usr/local/bin/acme records append *',
          temporaryOnly: false,
          reason: 'write leads with acme',
        },
      }) as never,
      sourceAgentFolder: 'main_agent',
      deps: deps as never,
      conversationBindings: {},
      sourceAgentFolderJids: ['sl:C123'],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingAccessRequests.markResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        resolution: 'denied',
      }),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.stringContaining('missing approving principal'),
      undefined,
    );
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
      error: 'Skill proposal requests require signed app scope.',
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
