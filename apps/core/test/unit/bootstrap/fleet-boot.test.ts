import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsRevision } from '@core/domain/ports/fleet-capability-state.js';

const latest = vi.hoisted(() => ({ current: null as SettingsRevision | null }));
const loadState = vi.hoisted(() => ({
  markSettingsLoaded: vi.fn(),
  markSettingsNotLoaded: vi.fn(),
}));
const importMock = vi.hoisted(() => ({ importWorkstationSettings: vi.fn() }));
const log = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    ops: {},
    repositories: {
      settingsRevisions: {
        getLatestSettingsRevision: async () => latest.current,
      },
    },
  }),
}));

vi.mock('@core/runtime/settings-load-state.js', () => ({
  markSettingsLoaded: loadState.markSettingsLoaded,
  markSettingsNotLoaded: loadState.markSettingsNotLoaded,
  areSettingsLoaded: () => true,
}));

vi.mock('@core/config/settings/settings-import-service.js', async () => {
  const actual = await vi.importActual<
    typeof import('@core/config/settings/settings-import-service.js')
  >('@core/config/settings/settings-import-service.js');
  return {
    ...actual,
    importWorkstationSettings: importMock.importWorkstationSettings,
    settingsFromRevisionDocument: () => ({}) as never,
  };
});

vi.mock('@core/infrastructure/logging/logger.js', () => ({ logger: log }));

import {
  buildBakeOutcomeNotice,
  prepareFleetSettings,
} from '@core/app/bootstrap/fleet-boot.js';
import type { RuntimeDependency } from '@core/domain/ports/fleet-capability-state.js';

const fakeApp = { loadState: async () => {} } as never;

function bakeDependency(
  overrides: Partial<RuntimeDependency> = {},
): RuntimeDependency {
  return {
    id: 'dep-1',
    appId: 'default',
    manifestHash: 'sha256:abc',
    requestedPackages: ['left-pad@1.3.0', 'pad-right@2.0.0'],
    status: 'uploaded',
    artifact: null,
    failureReason: null,
    requestedByAgentId: 'agent:main',
    approvedByConversationId: 'tg:approvals',
    approvedAt: '2026-06-11T00:00:00.000Z',
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('prepareFleetSettings', () => {
  beforeEach(() => {
    loadState.markSettingsLoaded.mockClear();
    loadState.markSettingsNotLoaded.mockClear();
    importMock.importWorkstationSettings.mockClear();
    log.warn.mockClear();
    log.info.mockClear();
  });

  it('marks settings not loaded and logs the seed command when no revision exists', async () => {
    latest.current = null;
    const result = await prepareFleetSettings({
      appId: 'default' as never,
      runtimeHome: '/tmp/gantry-fleet',
      app: fakeApp,
    });

    expect(result).toEqual({ loaded: false, revision: null });
    expect(loadState.markSettingsNotLoaded).toHaveBeenCalledOnce();
    expect(loadState.markSettingsLoaded).not.toHaveBeenCalled();
    expect(importMock.importWorkstationSettings).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        seedCommand: 'gantry settings import --file settings.yaml',
      }),
      expect.stringContaining('gantry settings import --file settings.yaml'),
    );
  });

  it('applies the latest revision through the shared import path and marks loaded', async () => {
    latest.current = {
      appId: 'default',
      revision: 9,
      settingsDocument: { yaml: 'agent: {}' },
      minReaderVersion: 1,
      createdBy: 'cli',
      note: null,
      createdAt: '2026-06-11T00:00:00.000Z',
    };
    const result = await prepareFleetSettings({
      appId: 'default' as never,
      runtimeHome: '/tmp/gantry-fleet',
      app: fakeApp,
    });

    expect(result).toEqual({ loaded: true, revision: 9 });
    expect(importMock.importWorkstationSettings).toHaveBeenCalledOnce();
    expect(loadState.markSettingsLoaded).toHaveBeenCalledOnce();
  });
});

describe('buildBakeOutcomeNotice', () => {
  beforeEach(() => {
    log.warn.mockClear();
  });

  it('sends one concise success notice naming the packages to the approval conversation', async () => {
    const sendMessage = vi.fn(async () => {});
    const notice = buildBakeOutcomeNotice(sendMessage);

    await notice.sendSuccessNotice({ dependency: bakeDependency() });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:approvals',
      'Dependency left-pad@1.3.0, pad-right@2.0.0 is baked and rolling out ' +
        'to workers — ready to use in about a minute. Re-ask the agent when ' +
        "you're ready.",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('sends the failure notice with the reason (unchanged)', async () => {
    const sendMessage = vi.fn(async () => {});
    const notice = buildBakeOutcomeNotice(sendMessage);

    await notice.sendFailureNotice({
      dependency: bakeDependency(),
      reason: 'npm install failed (exit 1)',
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:approvals',
      'Dependency bake failed: npm install failed (exit 1)',
    );
  });

  it('logs instead of sending when there is no approval conversation', async () => {
    const sendMessage = vi.fn(async () => {});
    const notice = buildBakeOutcomeNotice(sendMessage);

    await notice.sendSuccessNotice({
      dependency: bakeDependency({ approvedByConversationId: null }),
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ manifestHash: 'sha256:abc' }),
      'Toolchain bake succeeded but has no approval conversation to notify',
    );
  });

  it('logs delivery failures without throwing (never fails the bake)', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('channel down');
    });
    const notice = buildBakeOutcomeNotice(sendMessage);

    await expect(
      notice.sendSuccessNotice({ dependency: bakeDependency() }),
    ).resolves.toBeUndefined();
    await expect(
      notice.sendFailureNotice({
        dependency: bakeDependency(),
        reason: 'boom',
      }),
    ).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationJid: 'tg:approvals' }),
      'Failed to deliver toolchain bake success notice',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationJid: 'tg:approvals' }),
      'Failed to deliver toolchain bake failure notice',
    );
  });
});
