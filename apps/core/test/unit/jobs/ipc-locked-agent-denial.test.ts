import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

const runtimeHomes: string[] = [];

function lockedSettings(folder: string) {
  return {
    agents: {
      [folder]: {
        name: 'Support',
        folder,
        bindings: {},
        sources: { skills: [], mcpServers: [], tools: [] },
        capabilities: [],
        accessPreset: 'locked',
      },
    },
  };
}

function fullSettings(folder: string) {
  return {
    agents: {
      [folder]: {
        name: 'Support',
        folder,
        bindings: {},
        sources: { skills: [], mcpServers: [], tools: [] },
        capabilities: [],
        accessPreset: 'full',
      },
    },
  };
}

async function loadHandler(
  runtimeHome: string,
  settings: ReturnType<typeof lockedSettings> | 'throw',
) {
  vi.resetModules();
  vi.stubEnv('GANTRY_HOME', runtimeHome);
  const getRuntimeSettingsForConfig = vi.fn(() => {
    if (settings === 'throw') {
      throw new Error('settings.yaml unreadable');
    }
    return settings;
  });
  vi.doMock('@core/config/index.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('@core/config/index.js')>();
    return { ...actual, getRuntimeSettingsForConfig };
  });
  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  const handler = await import('@core/jobs/ipc-handler.js');
  return {
    processTaskIpc: handler.processTaskIpc,
    taskData: (
      taskId: string,
      type: string,
      extra: Record<string, unknown> = {},
    ) => {
      const envelope = ipcAuth.createIpcAuthEnvelope('support_agent');
      return {
        taskId,
        type,
        appId: 'app:test',
        responseKeyId: envelope.responseKeyId,
        chatJid: 'sl:C123',
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
        'support_agent',
        'task-responses',
        `task-${taskId}.json`,
      ),
      'utf-8',
    ),
  );
}

function makeDeps(extra: Record<string, unknown> = {}) {
  return {
    sendMessage: vi.fn(async () => undefined),
    conversationRoutes: () => ({
      'sl:C123': { folder: 'support_agent' },
    }),
    registerGroup: vi.fn(async () => undefined),
    syncGroups: vi.fn(async () => undefined),
    getAvailableGroups: vi.fn(async () => []),
    writeGroupsSnapshot: vi.fn(async () => undefined),
    onSchedulerChanged: vi.fn(() => undefined),
    requestPermissionApproval: vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    })),
    requestUserAnswer: vi.fn(async () => ({ response: '' })),
    opsRepository: {},
    ...extra,
  } as never;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('@core/config/index.js');
  for (const runtimeHome of runtimeHomes.splice(0)) {
    fs.rmSync(runtimeHome, { recursive: true, force: true });
  }
});

describe('locked agent parent-side IPC denial', () => {
  const DENIED_TYPES = [
    'request_skill_install',
    'request_skill_proposal',
    'request_skill_dependency_install',
    'request_mcp_server',
    'request_permission',
    'async_run_command',
    'async_mcp_call',
    'delegate_task',
    'task_get',
    'task_list',
    'task_cancel',
    'task_message',
    'settings_desired_state',
    'request_settings_update',
    'service_restart',
    'register_agent',
  ];

  it.each(DENIED_TYPES)(
    'denies forged %s IPC with denied_by_profile and never reaches the handler',
    async (type) => {
      const runtimeHome = fs.mkdtempSync(
        path.join(os.tmpdir(), 'gantry-locked-ipc-'),
      );
      runtimeHomes.push(runtimeHome);
      const { processTaskIpc, taskData } = await loadHandler(
        runtimeHome,
        lockedSettings('support_agent'),
      );
      const requestPermissionApproval = vi.fn(async () => ({
        approved: true,
        decidedBy: 'U_APPROVER',
      }));
      const publishRuntimeEvent = vi.fn(async () => undefined);
      const deps = makeDeps({ requestPermissionApproval, publishRuntimeEvent });

      await processTaskIpc(
        taskData(`forged-${type}`, type, {
          targetJid: 'sl:C123',
          payload: { reason: 'forged request' },
        }) as never,
        'support_agent',
        deps,
      );

      expect(readResponse(runtimeHome, `forged-${type}`)).toMatchObject({
        ok: false,
        code: 'denied_by_profile',
      });
      // The handler must never run for a denied task.
      expect(requestPermissionApproval).not.toHaveBeenCalled();
      // A denied_by_profile audit row is written.
      expect(publishRuntimeEvent).toHaveBeenCalledTimes(1);
      const auditEvent = publishRuntimeEvent.mock.calls[0]?.[0] as {
        eventType: string;
        actor: string;
        payload: { reasonCode: string; taskType: string };
      };
      expect(auditEvent.eventType).toBe('permission.denied');
      expect(auditEvent.actor).toBe('agent:support_agent');
      expect(auditEvent.payload.reasonCode).toBe('denied_by_profile');
      expect(auditEvent.payload.taskType).toBe(type);
    },
  );

  it('allows a full-preset agent to reach the same handler path', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-locked-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { processTaskIpc, taskData } = await loadHandler(
      runtimeHome,
      fullSettings('support_agent'),
    );
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const deps = makeDeps({ publishRuntimeEvent });

    await processTaskIpc(
      taskData('full-skill-install', 'request_skill_install', {
        targetJid: 'sl:C123',
        payload: { reason: 'real request' },
      }) as never,
      'support_agent',
      deps,
    );

    const response = readResponse(runtimeHome, 'full-skill-install');
    // Full agents are not denied by profile (the handler runs and applies its
    // own validation/approval logic instead).
    expect(response.code).not.toBe('denied_by_profile');
    expect(publishRuntimeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ reasonCode: 'denied_by_profile' }),
      }),
    );
  });

  it('still allows non-authority IPC tasks for locked agents', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-locked-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { processTaskIpc, taskData } = await loadHandler(
      runtimeHome,
      lockedSettings('support_agent'),
    );
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const deps = makeDeps({ publishRuntimeEvent });

    await processTaskIpc(
      taskData('locked-profile-read', 'agent_profile_read', {
        targetJid: 'sl:C123',
        payload: {},
      }) as never,
      'support_agent',
      deps,
    );

    const response = readResponse(runtimeHome, 'locked-profile-read');
    expect(response.code).not.toBe('denied_by_profile');
    expect(publishRuntimeEvent).not.toHaveBeenCalled();
  });

  it('authorizes a bare chat jid from an agent and provider-qualified route key', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-qualified-route-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { processTaskIpc, taskData } = await loadHandler(
      runtimeHome,
      fullSettings('support_agent'),
    );
    const qualifiedRouteKey = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:support_agent',
      undefined,
      'slack_default',
    );
    const deps = makeDeps({
      conversationRoutes: () => ({
        [qualifiedRouteKey]: {
          folder: 'support_agent',
          providerAccountId: 'slack_default',
        },
      }),
    });

    await processTaskIpc(
      taskData('qualified-route-profile-read', 'agent_profile_read', {
        payload: { file: 'invalid' },
      }) as never,
      'support_agent',
      deps,
    );

    expect(
      readResponse(runtimeHome, 'qualified-route-profile-read'),
    ).toMatchObject({
      code: 'invalid_request',
      error: 'file must be soul or agents.',
    });
  });

  it('fails closed when settings are unreadable during a denied-type task', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-locked-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { processTaskIpc, taskData } = await loadHandler(
      runtimeHome,
      'throw',
    );
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const deps = makeDeps({ requestPermissionApproval, publishRuntimeEvent });

    await processTaskIpc(
      taskData('unknown-skill-install', 'request_skill_install', {
        targetJid: 'sl:C123',
        payload: { reason: 'request during settings outage' },
      }) as never,
      'support_agent',
      deps,
    );

    expect(readResponse(runtimeHome, 'unknown-skill-install')).toMatchObject({
      ok: false,
      code: 'denied_by_profile',
    });
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'permission.denied',
        payload: expect.objectContaining({
          reasonCode: 'denied_by_profile',
          accessPreset: 'unknown',
          taskType: 'request_skill_install',
        }),
      }),
    );
  });

  it('keeps non-authority tasks unaffected when settings are unreadable', async () => {
    const runtimeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-locked-ipc-'),
    );
    runtimeHomes.push(runtimeHome);
    const { processTaskIpc, taskData } = await loadHandler(
      runtimeHome,
      'throw',
    );
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const deps = makeDeps({ publishRuntimeEvent });

    await processTaskIpc(
      taskData('unknown-profile-read', 'agent_profile_read', {
        targetJid: 'sl:C123',
        payload: {},
      }) as never,
      'support_agent',
      deps,
    );

    const response = readResponse(runtimeHome, 'unknown-profile-read');
    expect(response.code).not.toBe('denied_by_profile');
    expect(publishRuntimeEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ reasonCode: 'denied_by_profile' }),
      }),
    );
  });
});
