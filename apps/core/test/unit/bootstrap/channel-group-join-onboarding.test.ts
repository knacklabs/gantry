import { describe, expect, it, vi } from 'vitest';

import { createGroupJoinOnboardingCoordinator } from '@core/config/settings/group-join-onboarding.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import { SettingsStaleMutationError } from '@core/config/settings/settings-import-service.js';
import type {
  GroupJoinOnboardingRecord,
  GroupJoinOnboardingRepository,
} from '@core/domain/ports/group-join-onboarding.js';

function promptedRecord(): GroupJoinOnboardingRecord {
  return {
    id: 'opaque-1',
    providerAccountId: 'telegram_main',
    chatJid: 'tg:-1001234',
    status: 'prompted',
    adder: '111',
    approver: '222',
    promptConversationJid: 'tg:222',
    promptAgentFolder: 'main_agent',
    promptedAt: '2026-07-18T00:00:00.000Z',
    dismissedAt: null,
    registeredAt: null,
    leftAt: null,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

function settingsFixture() {
  const settings = createDefaultRuntimeSettings();
  settings.providerAccounts.telegram_main = {
    agentId: 'main_agent',
    provider: 'telegram',
    label: 'Telegram Main',
    runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
    config: {},
  };
  return settings;
}

function repositoryFixture(record = promptedRecord()) {
  const registered = { ...record, status: 'registered' as const };
  return {
    recordPrompt: vi.fn(async () => record),
    getById: vi.fn(async () => record),
    markDismissed: vi.fn(async () => ({
      ...record,
      status: 'dismissed' as const,
    })),
    markRegistered: vi.fn(async () => registered),
    revertRegistered: vi.fn(async () => record),
    markLeft: vi.fn(async () => ({ ...record, leftAt: record.updatedAt })),
  } satisfies GroupJoinOnboardingRepository;
}

function statefulRepositoryFixture(record = promptedRecord()) {
  let current = record;
  const repository = {
    recordPrompt: vi.fn(async () => current),
    getById: vi.fn(async () => current),
    markDismissed: vi.fn(async (input: { now: string }) => {
      if (current.status !== 'prompted') return null;
      current = {
        ...current,
        status: 'dismissed',
        dismissedAt: input.now,
        updatedAt: input.now,
      };
      return current;
    }),
    markRegistered: vi.fn(async (input: { now: string }) => {
      if (current.status !== 'prompted') return null;
      current = {
        ...current,
        status: 'registered',
        registeredAt: input.now,
        updatedAt: input.now,
      };
      return current;
    }),
    revertRegistered: vi.fn(async (input: { now: string }) => {
      if (current.status !== 'registered') return null;
      current = {
        ...current,
        status: 'prompted',
        registeredAt: null,
        updatedAt: input.now,
      };
      return current;
    }),
    markLeft: vi.fn(async () => ({ ...current, leftAt: current.updatedAt })),
  } satisfies GroupJoinOnboardingRepository;
  return { repository, current: () => current };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

describe('group join onboarding coordinator', () => {
  it('keeps registration when dismissal races after the registration claim', async () => {
    const { repository, current } = statefulRepositoryFixture();
    const writeStarted = deferred();
    const allowWrite = deferred();
    const writeSettings = vi.fn(async () => {
      writeStarted.resolve();
      await allowWrite.promise;
      return { reconciled: true, restartRequired: [] };
    });
    const coordinator = createGroupJoinOnboardingCoordinator({
      runtimeHome: '/tmp/group-join-test',
      repository: () => repository,
      loadSettings: vi.fn(async () => settingsFixture()),
      writeSettings,
      reloadRuntimeState: vi.fn(async () => undefined),
      now: () => '2026-07-18T01:00:00.000Z',
      newId: () => 'unused',
    });

    const registration = coordinator.register({
      id: 'opaque-1',
      externalId: '-1001234',
      title: 'Ops Room',
      approvedBy: '222',
    });
    await writeStarted.promise;

    await expect(coordinator.dismiss('opaque-1')).resolves.toBeNull();
    allowWrite.resolve();
    await expect(registration).resolves.toMatchObject({ status: 'registered' });

    expect(writeSettings).toHaveBeenCalledOnce();
    expect(current()).toMatchObject({ status: 'registered' });
  });

  it('skips the settings write when dismissal claims the prompt first', async () => {
    const { repository, current } = statefulRepositoryFixture();
    const writeSettings = vi.fn();
    const coordinator = createGroupJoinOnboardingCoordinator({
      runtimeHome: '/tmp/group-join-test',
      repository: () => repository,
      loadSettings: vi.fn(async () => settingsFixture()),
      writeSettings,
      reloadRuntimeState: vi.fn(async () => undefined),
      now: () => '2026-07-18T01:00:00.000Z',
      newId: () => 'unused',
    });

    await expect(coordinator.dismiss('opaque-1')).resolves.toMatchObject({
      status: 'dismissed',
    });
    await expect(
      coordinator.register({
        id: 'opaque-1',
        externalId: '-1001234',
        title: 'Ops Room',
        approvedBy: '222',
      }),
    ).resolves.toBeNull();

    expect(writeSettings).not.toHaveBeenCalled();
    expect(current()).toMatchObject({ status: 'dismissed' });
  });

  it('reverts the registration claim when the settings write fails', async () => {
    const { repository, current } = statefulRepositoryFixture();
    const writeError = new SettingsStaleMutationError();
    const writeSettings = vi.fn().mockRejectedValue(writeError);
    const coordinator = createGroupJoinOnboardingCoordinator({
      runtimeHome: '/tmp/group-join-test',
      repository: () => repository,
      loadSettings: vi.fn(async () => settingsFixture()),
      writeSettings,
      reloadRuntimeState: vi.fn(async () => undefined),
      now: () => '2026-07-18T01:00:00.000Z',
      newId: () => 'unused',
    });

    await expect(
      coordinator.register({
        id: 'opaque-1',
        externalId: '-1001234',
        title: 'Ops Room',
        approvedBy: '222',
      }),
    ).rejects.toBe(writeError);

    expect(writeSettings).toHaveBeenCalledTimes(2);
    expect(repository.revertRegistered).toHaveBeenCalledOnce();
    expect(current()).toMatchObject({
      status: 'prompted',
      registeredAt: null,
    });
  });

  it('allows only one concurrent registration to write settings', async () => {
    const { repository, current } = statefulRepositoryFixture();
    const writeSettings = vi.fn(async () => ({
      reconciled: true,
      restartRequired: [],
    }));
    const coordinator = createGroupJoinOnboardingCoordinator({
      runtimeHome: '/tmp/group-join-test',
      repository: () => repository,
      loadSettings: vi.fn(async () => settingsFixture()),
      writeSettings,
      reloadRuntimeState: vi.fn(async () => undefined),
      now: () => '2026-07-18T01:00:00.000Z',
      newId: () => 'unused',
    });
    const input = {
      id: 'opaque-1',
      externalId: '-1001234',
      title: 'Ops Room',
      approvedBy: '222',
    };

    const results = await Promise.all([
      coordinator.register(input),
      coordinator.register(input),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: 'registered' }),
      null,
    ]);
    expect(writeSettings).toHaveBeenCalledOnce();
    expect(current()).toMatchObject({ status: 'registered' });
  });

  it('registers through the canonical desired-state write with the approver receipt identity', async () => {
    const repository = repositoryFixture();
    const settings = settingsFixture();
    const writeSettings = vi.fn(async () => ({
      reconciled: true,
      restartRequired: [],
    }));
    const reloadRuntimeState = vi.fn(async () => undefined);
    const coordinator = createGroupJoinOnboardingCoordinator({
      runtimeHome: '/tmp/group-join-test',
      repository: () => repository,
      loadSettings: vi.fn(async () => structuredClone(settings)),
      writeSettings,
      reloadRuntimeState,
      now: () => '2026-07-18T01:00:00.000Z',
      newId: () => 'unused',
    });

    await expect(
      coordinator.register({
        id: 'opaque-1',
        externalId: '-1001234',
        title: 'Ops Room',
        approvedBy: '222',
      }),
    ).resolves.toMatchObject({ status: 'registered' });

    expect(writeSettings).toHaveBeenCalledOnce();
    const write = writeSettings.mock.calls[0]![0];
    expect(write).toMatchObject({
      runtimeHome: '/tmp/group-join-test',
      createdBy: 'interaction:group-join:222',
    });
    expect(Object.values(write.settings.conversations)).toContainEqual(
      expect.objectContaining({
        providerAccount: 'telegram_main',
        externalId: '-1001234',
        kind: 'channel',
        displayName: 'Ops Room',
        senderPolicy: { allow: '*', mode: 'trigger' },
        controlApprovers: ['222'],
        installedAgents: {
          main_agent: expect.objectContaining({
            agentId: 'main_agent',
            providerAccountId: 'telegram_main',
            requiresTrigger: true,
          }),
        },
      }),
    );
    expect(reloadRuntimeState).toHaveBeenCalledOnce();
    expect(repository.markRegistered).toHaveBeenCalledWith({
      id: 'opaque-1',
      now: '2026-07-18T01:00:00.000Z',
    });
  });

  it('retries one stale settings mutation before registering', async () => {
    const repository = repositoryFixture();
    const loadSettings = vi.fn(async () => settingsFixture());
    const writeSettings = vi
      .fn()
      .mockRejectedValueOnce(new SettingsStaleMutationError())
      .mockResolvedValueOnce({ reconciled: true, restartRequired: [] });
    const coordinator = createGroupJoinOnboardingCoordinator({
      runtimeHome: '/tmp/group-join-test',
      repository: () => repository,
      loadSettings,
      writeSettings,
      reloadRuntimeState: vi.fn(async () => undefined),
      now: () => '2026-07-18T01:00:00.000Z',
      newId: () => 'unused',
    });

    await expect(
      coordinator.register({
        id: 'opaque-1',
        externalId: '-1001234',
        title: 'Ops Room',
        approvedBy: '222',
      }),
    ).resolves.toMatchObject({ status: 'registered' });

    expect(loadSettings).toHaveBeenCalledTimes(2);
    expect(writeSettings).toHaveBeenCalledTimes(2);
    expect(repository.markRegistered).toHaveBeenCalledOnce();
  });
});
