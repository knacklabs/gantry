import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { permissionDecisionResult } from '../../channels/permission-approval-result-helpers.js';
import { durablePermissionRequestSnapshot } from '@core/application/interactions/durable-interaction-handler.js';
import {
  applyRecoveredPersistentPermissionGrant,
  type PermissionPersistenceBackend,
} from '@core/application/interactions/pending-interaction-permission-recovery.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '@core/domain/types.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { processPermissionInteractionIpc } from '@core/runtime/ipc-interaction-processing.js';
import { registerWorkerPermissionRunRestriction } from '@core/runtime/agent-spawn-permission-run-restriction.js';
import { unregisterPermissionRunRestriction } from '@core/runtime/permission-decision-coordinator.js';

const sourceAgentFolder = 'main_agent';

function persistentDecision(): PermissionApprovalDecision {
  return {
    approved: true,
    mode: 'allow_persistent_rule',
    decidedBy: 'owner-1',
    decisionClassification: 'user_permanent',
    updatedPermissions: [
      {
        type: 'addRules',
        behavior: 'allow',
        rules: [{ toolName: 'Browser' }],
      },
    ],
  };
}

function permissionPersistence(bindings: Record<string, unknown>[]): {
  persistence: PermissionPersistenceBackend;
  getJobById: ReturnType<typeof vi.fn>;
} {
  const browserTool = {
    id: 'tool:Browser',
    appId: 'app:test',
    name: 'Browser',
    kind: 'browser',
    provider: 'gantry',
    displayName: 'Browser',
    category: 'agent',
    risk: 'medium',
    selectable: true,
    status: 'active',
    adapterRef: 'browser',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };
  const getJobById = vi.fn(async () => undefined);
  return {
    getJobById,
    persistence: {
      opsRepository: {
        getJobById,
        listJobs: vi.fn(async () => []),
      } as never,
      getToolRepository: () =>
        ({
          listTools: vi.fn(async () => [browserTool]),
          getTool: vi.fn(async () => browserTool),
          listAgentToolBindings: vi.fn(async () => bindings),
          saveAgentToolBinding: vi.fn(async (binding) => {
            bindings.push(binding);
          }),
          disableAgentToolBinding: vi.fn(async () => null),
        }) as never,
      mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
    },
  };
}

describe('live-turn person scoping', () => {
  const registeredRestrictions: Array<{
    sourceAgentFolder: string;
    responseKeyId: string;
  }> = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const key of registeredRestrictions.splice(0)) {
      unregisterPermissionRunRestriction(key);
    }
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function hostStampedSnapshot(input: {
    requestId: string;
    memoryUserId?: string;
    workerPersonId?: string;
  }): Promise<PermissionApprovalRequest> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'person-grant-'));
    tempDirs.push(tempDir);
    const envelope = createIpcAuthEnvelope(sourceAgentFolder, null);
    const restrictionKey = {
      sourceAgentFolder,
      responseKeyId: envelope.responseKeyId,
    };
    registeredRestrictions.push(restrictionKey);
    registerWorkerPermissionRunRestriction({
      ...restrictionKey,
      hideAuthorityTools: false,
      runKind: 'interactive',
      memoryUserId: input.memoryUserId,
    });
    const claimedPath = path.join(tempDir, `${input.requestId}.json`);
    fs.writeFileSync(claimedPath, '{}');
    let promptedRequest: PermissionApprovalRequest | undefined;

    await processPermissionInteractionIpc({
      request: {
        requestId: input.requestId,
        appId: 'app:test',
        agentId: 'agent:test',
        sourceAgentFolder,
        responseKeyId: envelope.responseKeyId,
        personId: input.workerPersonId,
        targetJid: 'dm:owner-1',
        toolName: 'mcp__gantry__admin_permission_list',
        toolInput: {},
      },
      sourceAgentFolder,
      deps: {
        requestPermissionApproval: vi.fn(async (request) => {
          promptedRequest = request;
          return permissionDecisionResult({
            approved: false,
            mode: 'cancel' as const,
            decidedBy: 'owner-1',
            decisionClassification: 'user_reject' as const,
          });
        }),
      },
      ipcBaseDir: tempDir,
      file: path.basename(claimedPath),
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(promptedRequest).toBeDefined();
    return durablePermissionRequestSnapshot(promptedRequest!);
  }

  it('eligible DM turn writes person-scoped grant; no-person turn writes shared; snapshot round-trips personId', async () => {
    const personSnapshot = await hostStampedSnapshot({
      requestId: 'person-grant',
      memoryUserId: 'person:owner-1',
      workerPersonId: 'person:forged-worker',
    });
    expect(personSnapshot.personId).toBe('person:owner-1');

    const personBindings: Record<string, unknown>[] = [];
    const personBackend = permissionPersistence(personBindings);
    await expect(
      applyRecoveredPersistentPermissionGrant({
        persistence: personBackend.persistence,
        request: personSnapshot,
        sourceAgentFolder,
        decision: persistentDecision(),
      }),
    ).resolves.toBe(true);
    expect(personBindings).toContainEqual(
      expect.objectContaining({ personId: 'person:owner-1' }),
    );
    expect(personBackend.getJobById).not.toHaveBeenCalled();

    const sharedSnapshot = await hostStampedSnapshot({
      requestId: 'shared-grant',
      workerPersonId: 'person:forged-worker',
    });
    expect(sharedSnapshot.personId).toBeUndefined();

    const sharedBindings: Record<string, unknown>[] = [];
    const sharedBackend = permissionPersistence(sharedBindings);
    await expect(
      applyRecoveredPersistentPermissionGrant({
        persistence: sharedBackend.persistence,
        request: sharedSnapshot,
        sourceAgentFolder,
        decision: persistentDecision(),
      }),
    ).resolves.toBe(true);
    expect(sharedBindings).toContainEqual(
      expect.objectContaining({ personId: null }),
    );
    expect(sharedBackend.getJobById).not.toHaveBeenCalled();

    const scheduledBindings: Record<string, unknown>[] = [];
    const scheduledBackend = permissionPersistence(scheduledBindings);
    await expect(
      applyRecoveredPersistentPermissionGrant({
        persistence: scheduledBackend.persistence,
        request: { ...personSnapshot, jobId: 'job:missing' },
        sourceAgentFolder,
        decision: persistentDecision(),
      }),
    ).resolves.toBe(false);
    expect(scheduledBackend.getJobById).toHaveBeenCalledWith('job:missing');
    expect(scheduledBindings).toEqual([]);
  });
});
