import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-locked-perm-'));
  tempDirs.push(dir);
  return dir;
}

function agentSettings(preset: 'full' | 'locked') {
  return {
    agents: {
      support_agent: {
        name: 'Support',
        folder: 'support_agent',
        bindings: {},
        sources: { skills: [], mcpServers: [], tools: [] },
        capabilities: [],
        accessPreset: preset,
      },
    },
  };
}

// Mocks the settings source only (never the gate): the real
// resolveAgentLockStatus + processPermissionInteractionIpc run unmodified.
async function loadProcessing(behavior: 'locked' | 'full' | 'throw') {
  vi.resetModules();
  vi.doMock('@core/config/index.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('@core/config/index.js')>();
    return {
      ...actual,
      getRuntimeSettingsForConfig: vi.fn(() => {
        if (behavior === 'throw') {
          throw new Error('settings.yaml unreadable');
        }
        return agentSettings(behavior) as never;
      }),
    };
  });
  const processing =
    await import('@core/runtime/ipc-interaction-processing.js');
  const durability =
    await import('@core/application/interactions/pending-interaction-durability.js');
  const ipcAuth = await import('@core/runtime/ipc-auth.js');
  return { processing, durability, ipcAuth };
}

function makeDurabilityRepository() {
  return {
    getActiveRunLease: vi.fn(async () => null),
    createPendingInteraction: vi.fn(async () => true),
    listPendingInteractions: vi.fn(async () => []),
    resolvePendingInteraction: vi.fn(async () => true),
    createTransientGrant: vi.fn(async () => true),
  };
}

afterEach(() => {
  vi.doUnmock('@core/config/index.js');
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('locked agent parent-side permission IPC denial', () => {
  it('denies a forged permission request from a locked agent before any authority outcome', async () => {
    const { processing, durability, ipcAuth } = await loadProcessing('locked');
    const tempDir = makeTempDir();
    const claimedPath = path.join(tempDir, 'claimed-forged-permission.json');
    fs.writeFileSync(claimedPath, '{}');
    const envelope = ipcAuth.createIpcAuthEnvelope('support_agent');
    const repository = makeDurabilityRepository();
    durability.configurePendingInteractionDurability({
      repository: repository as never,
    });
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await processing.processPermissionInteractionIpc({
      request: {
        requestId: 'perm-forged-locked',
        appId: 'app:test',
        agentId: 'agent:support',
        responseNonce: 'nonce-forged',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'support_agent',
        targetJid: 'tg:support',
        toolName: 'mcp__gantry__request_access',
      },
      sourceAgentFolder: 'support_agent',
      deps: {
        requestPermissionApproval,
        publishRuntimeEvent,
      } as never,
      ipcBaseDir: tempDir,
      file: 'claimed-forged-permission.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    // No prompt was rendered and no durable pending row was created.
    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(repository.createPendingInteraction).not.toHaveBeenCalled();
    expect(repository.createTransientGrant).not.toHaveBeenCalled();

    // The denial response was written for the runner.
    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          tempDir,
          'support_agent',
          'permission-responses',
          'perm-forged-locked.json',
        ),
        'utf-8',
      ),
    );
    expect(response).toMatchObject({
      requestId: 'perm-forged-locked',
      approved: false,
      reason: expect.stringContaining('denied_by_profile'),
    });

    // The denied_by_profile audit event was emitted.
    expect(publishRuntimeEvent).toHaveBeenCalledTimes(1);
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'permission.denied',
        actor: 'agent:support_agent',
        correlationId: 'perm-forged-locked',
        payload: expect.objectContaining({
          reasonCode: 'denied_by_profile',
          accessPreset: 'locked',
          toolName: 'mcp__gantry__request_access',
        }),
      }),
    );

    // The claimed request file was archived, not left for reprocessing.
    expect(fs.existsSync(claimedPath)).toBe(false);
  });

  it('fails closed with accessPreset unknown when settings are unreadable', async () => {
    const { processing, durability, ipcAuth } = await loadProcessing('throw');
    const tempDir = makeTempDir();
    const claimedPath = path.join(tempDir, 'claimed-unknown-permission.json');
    fs.writeFileSync(claimedPath, '{}');
    const envelope = ipcAuth.createIpcAuthEnvelope('support_agent');
    const repository = makeDurabilityRepository();
    durability.configurePendingInteractionDurability({
      repository: repository as never,
    });
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'U_APPROVER',
    }));
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await processing.processPermissionInteractionIpc({
      request: {
        requestId: 'perm-unknown-settings',
        appId: 'app:test',
        responseNonce: 'nonce-unknown',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'support_agent',
        targetJid: 'tg:support',
        toolName: 'Bash',
      },
      sourceAgentFolder: 'support_agent',
      deps: {
        requestPermissionApproval,
        publishRuntimeEvent,
      } as never,
      ipcBaseDir: tempDir,
      file: 'claimed-unknown-permission.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(repository.createPendingInteraction).not.toHaveBeenCalled();
    const response = JSON.parse(
      fs.readFileSync(
        path.join(
          tempDir,
          'support_agent',
          'permission-responses',
          'perm-unknown-settings.json',
        ),
        'utf-8',
      ),
    );
    expect(response).toMatchObject({
      approved: false,
      reason: expect.stringContaining('denied_by_profile'),
    });
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'permission.denied',
        payload: expect.objectContaining({
          reasonCode: 'denied_by_profile',
          accessPreset: 'unknown',
        }),
      }),
    );
  });

  it('lets a full-preset agent permission request reach the prompt path', async () => {
    const { processing, durability, ipcAuth } = await loadProcessing('full');
    const tempDir = makeTempDir();
    const claimedPath = path.join(tempDir, 'claimed-full-permission.json');
    fs.writeFileSync(claimedPath, '{}');
    const envelope = ipcAuth.createIpcAuthEnvelope('support_agent');
    const repository = makeDurabilityRepository();
    durability.configurePendingInteractionDurability({
      repository: repository as never,
    });
    const requestPermissionApproval = vi.fn(async () => ({
      approved: false,
      mode: 'cancel',
      decidedBy: 'owner',
      decisionClassification: 'user_reject',
    }));

    await processing.processPermissionInteractionIpc({
      request: {
        requestId: 'perm-full-agent',
        appId: 'app:test',
        agentId: 'agent:support',
        responseNonce: 'nonce-full',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'support_agent',
        targetJid: 'tg:support',
        toolName: 'Bash',
      },
      sourceAgentFolder: 'support_agent',
      deps: {
        requestPermissionApproval,
      } as never,
      ipcBaseDir: tempDir,
      file: 'claimed-full-permission.json',
      claimedPath,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    // Gate did not block: the pending row was created and the prompt rendered.
    expect(repository.createPendingInteraction).toHaveBeenCalledTimes(1);
    expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
  });
});
