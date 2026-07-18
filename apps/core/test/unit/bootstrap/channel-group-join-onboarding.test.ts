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
    markLeft: vi.fn(async () => ({ ...record, leftAt: record.updatedAt })),
  } satisfies GroupJoinOnboardingRepository;
}

describe('group join onboarding coordinator', () => {
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
