import { describe, expect, it, vi } from 'vitest';

import { ApplicationError } from '@core/application/common/application-error.js';
import type { ChannelOpts } from '@core/channels/channel-provider.js';
import {
  bootstrapGroupInstall,
  GROUP_INSTALL_MANUAL_SETUP_MESSAGE,
} from '@core/channels/group-install-bootstrap.js';
import { createGroupJoinOnboardingCoordinator } from '@core/config/settings/group-join-onboarding.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';
import type {
  GroupJoinOnboardingRecord,
  GroupJoinOnboardingRepository,
} from '@core/domain/ports/group-join-onboarding.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

const NOW = '2026-08-10T00:00:00.000Z';

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

function harness(input: {
  resolve: () => Promise<{
    status: 'resolved' | 'unresolved';
    personId: string | null;
    memoryHydrationEligible: boolean;
  }>;
  hasDirectConversation?: boolean;
}) {
  const settings = settingsFixture();
  let claimed = false;
  let current: GroupJoinOnboardingRecord | null = null;
  let participantPresent = false;
  let desiredApprovers: string[] = [];
  let durableApprovers: string[] = [];
  const order: string[] = [];
  const repository = {
    recordBootstrap: vi.fn(async (claim) => {
      if (claimed) return null;
      claimed = true;
      current = {
        id: claim.id,
        providerAccountId: claim.providerAccountId,
        chatJid: claim.chatJid,
        status: 'prompted',
        adder: claim.adder,
        approver: claim.approver,
        promptConversationJid: claim.promptConversationJid,
        promptAgentFolder: claim.promptAgentFolder,
        promptedAt: claim.now,
        dismissedAt: null,
        registeredAt: null,
        leftAt: null,
        createdAt: claim.now,
        updatedAt: claim.now,
      };
      return current;
    }),
    markRegistered: vi.fn(async ({ now }) => {
      if (!current || current.status !== 'prompted') return null;
      current = {
        ...current,
        status: 'registered',
        registeredAt: now,
        updatedAt: now,
      };
      return current;
    }),
    revertRegistered: vi.fn(async () => null),
    markLeft: vi.fn(async () => null),
    hasDirectConversationWithPerson: vi.fn(
      async () => input.hasDirectConversation !== false,
    ),
    ensureInstallerParticipant: vi.fn(async ({ installerExternalId }) => {
      order.push(`participant:${installerExternalId}`);
      participantPresent = true;
    }),
  } satisfies GroupJoinOnboardingRepository;
  const writeSettings = vi.fn(async ({ settings: nextSettings }) => {
    order.push('settings');
    desiredApprovers =
      Object.values(nextSettings.conversations)[0]?.controlApprovers ?? [];
    return { reconciled: true, restartRequired: [] };
  });
  const reloadRuntimeState = vi.fn(async () => {
    order.push('reconcile');
    durableApprovers = participantPresent ? [...desiredApprovers] : [];
  });
  const coordinator = createGroupJoinOnboardingCoordinator({
    runtimeHome: '/tmp/group-install-bootstrap-test',
    repository: () => repository,
    loadSettings: vi.fn(async () => settings),
    writeSettings,
    reloadRuntimeState,
    now: () => NOW,
    newId: () => 'bootstrap-1',
  });
  const onChatMetadata = vi.fn(async () => undefined);
  const routes: Record<string, unknown> = {};
  const opts = {
    appId: 'default',
    providerAccountId: 'telegram_main',
    onChatMetadata,
    conversationRoutes: () => routes,
    groupJoinOnboarding: coordinator,
    resolvePersonIdentity: input.resolve,
    hasDirectConversationWithPerson: repository.hasDirectConversationWithPerson,
  } as unknown as ChannelOpts;
  const send = vi.fn(async () => undefined);

  return {
    settings,
    repository,
    writeSettings,
    reloadRuntimeState,
    durableApprovers: () => durableApprovers,
    order,
    opts,
    send,
    routes,
    onChatMetadata,
  };
}

describe('group install bootstrap', () => {
  it('recognised seeds installer and survives reconcile; unrecognised fails closed; dedup holds', async () => {
    const recognised = harness({
      resolve: async () => ({
        status: 'resolved',
        personId: 'person-111',
        memoryHydrationEligible: true,
      }),
    });
    const install = {
      opts: recognised.opts,
      provider: 'telegram',
      providerAccountId: 'telegram_main',
      chatJid: 'tg:-1001234',
      title: 'Ops Room',
      installerExternalId: '111',
      send: recognised.send,
    };

    await expect(bootstrapGroupInstall(install)).resolves.toBe('registered');
    expect(recognised.writeSettings).toHaveBeenCalledOnce();
    expect(
      recognised.repository.ensureInstallerParticipant,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ installerExternalId: '111' }),
    );
    expect(recognised.order).toEqual([
      'settings',
      'reconcile',
      'participant:111',
      'reconcile',
    ]);
    expect(recognised.durableApprovers()).toEqual(['111']);
    expect(recognised.send).toHaveBeenCalledWith(
      "I'm set up. The person who added me can approve what I'm allowed to do here.",
    );

    const configuredConversation = Object.values(
      recognised.settings.conversations,
    )[0]!;
    configuredConversation.controlApprovers = ['existing-approver'];
    await expect(bootstrapGroupInstall(install)).resolves.toBe('deduplicated');
    expect(recognised.writeSettings).toHaveBeenCalledOnce();
    expect(recognised.send).toHaveBeenCalledOnce();
    expect(configuredConversation.controlApprovers).toEqual([
      'existing-approver',
    ]);

    const alreadyRegistered = harness({
      resolve: async () => ({
        status: 'resolved',
        personId: 'person-111',
        memoryHydrationEligible: true,
      }),
    });
    alreadyRegistered.routes[
      makeAgentThreadQueueKey(
        'tg:-1001234',
        'agent:main_agent',
        null,
        'telegram_main',
      )
    ] = {};
    await expect(
      bootstrapGroupInstall({
        ...install,
        opts: alreadyRegistered.opts,
        send: alreadyRegistered.send,
      }),
    ).resolves.toBe('deduplicated');
    expect(alreadyRegistered.onChatMetadata).toHaveBeenCalledOnce();
    expect(alreadyRegistered.repository.recordBootstrap).not.toHaveBeenCalled();
    expect(alreadyRegistered.send).not.toHaveBeenCalled();

    const unrecognisedCases = [
      harness({
        resolve: async () => ({
          status: 'unresolved',
          personId: null,
          memoryHydrationEligible: false,
        }),
      }),
      harness({
        resolve: async () => {
          throw new ApplicationError(
            'CONFLICT',
            'Alias is retired and cannot resolve active personal memory.',
          );
        },
      }),
      harness({
        resolve: async () => ({
          status: 'resolved',
          personId: 'person-111',
          memoryHydrationEligible: true,
        }),
        hasDirectConversation: false,
      }),
    ];
    for (const unrecognised of unrecognisedCases) {
      const unrecognisedInstall = {
        ...install,
        opts: unrecognised.opts,
        send: unrecognised.send,
      };
      await expect(bootstrapGroupInstall(unrecognisedInstall)).resolves.toBe(
        'manual',
      );
      await expect(bootstrapGroupInstall(unrecognisedInstall)).resolves.toBe(
        'deduplicated',
      );
      expect(unrecognised.writeSettings).not.toHaveBeenCalled();
      expect(
        unrecognised.repository.ensureInstallerParticipant,
      ).not.toHaveBeenCalled();
      expect(unrecognised.send).toHaveBeenCalledOnce();
      expect(unrecognised.send).toHaveBeenCalledWith(
        GROUP_INSTALL_MANUAL_SETUP_MESSAGE,
      );
    }
  });
});
