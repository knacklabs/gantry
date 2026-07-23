import { describe, expect, it } from 'vitest';

import {
  resolveObserverActivationStatus,
  resolveObserverOwnerRoute,
  resolveVerifiedObserverActivationStatus,
} from '@core/config/settings/observer-activation.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings-defaults.js';

function configuredObserverSettings() {
  const settings = createDefaultRuntimeSettings();
  settings.providers.slack = { enabled: true };
  settings.providerAccounts.slack_owner = {
    agentId: 'main_agent',
    provider: 'slack',
    label: 'Owner Slack',
    runtimeSecretRefs: {},
  };
  settings.conversations.owner_dm = {
    providerAccount: 'slack_owner',
    externalId: 'D123',
    kind: 'dm',
    displayName: 'Owner DM',
    senderPolicy: { allow: '*', mode: 'trigger' },
    controlApprovers: ['U123'],
    installedAgents: {},
  };
  settings.observer = {
    enabled: true,
    owner: { recipient: 'U123', conversation: 'owner_dm' },
  };
  return settings;
}

describe('observer activation', () => {
  it('defaults to disabled', () => {
    expect(
      resolveObserverActivationStatus(createDefaultRuntimeSettings()),
    ).toEqual({
      state: 'disabled',
      enabled: false,
      active: false,
      reason: 'observer_disabled',
      message: 'Observer is disabled.',
    });
  });

  it('requires an explicit owner and a direct conversation', () => {
    const settings = createDefaultRuntimeSettings();
    settings.observer.enabled = true;
    expect(resolveObserverActivationStatus(settings)).toMatchObject({
      state: 'configuration_required',
      reason: 'owner_not_configured',
    });

    const configured = configuredObserverSettings();
    configured.conversations.owner_dm.kind = 'channel';
    expect(resolveObserverOwnerRoute(configured)).toEqual({
      ok: false,
      reason: 'owner_conversation_not_direct',
    });

    const wrongRecipient = configuredObserverSettings();
    wrongRecipient.observer.owner = {
      recipient: 'U999',
      conversation: 'owner_dm',
    };
    expect(resolveObserverOwnerRoute(wrongRecipient)).toEqual({
      ok: false,
      reason: 'owner_recipient_not_approver',
    });
  });

  it('requires an active provider account on an enabled provider', () => {
    const disabledAccount = configuredObserverSettings();
    disabledAccount.providerAccounts.slack_owner!.status = 'disabled';
    expect(resolveObserverOwnerRoute(disabledAccount)).toEqual({
      ok: false,
      reason: 'owner_provider_account_disabled',
    });

    const disabledProvider = configuredObserverSettings();
    disabledProvider.providers.slack = { enabled: false };
    expect(resolveObserverOwnerRoute(disabledProvider)).toEqual({
      ok: false,
      reason: 'owner_provider_disabled',
    });
  });

  it('resolves the canonical owner DM route separately from insight subjects', () => {
    const resolved = resolveObserverOwnerRoute(configuredObserverSettings());

    expect(resolved).toMatchObject({
      ok: true,
      owner: {
        recipient: 'U123',
        conversation: 'owner_dm',
        conversationJid: 'sl:D123',
        providerAccountId: 'slack_owner',
        providerId: 'slack',
        externalConversationId: 'D123',
      },
    });
  });

  it('reports evidence accumulation until memory dreaming is effectively on', () => {
    const settings = configuredObserverSettings();
    expect(resolveObserverActivationStatus(settings)).toMatchObject({
      state: 'evidence_accumulating',
      active: false,
      reason: 'dreaming_disabled',
      message:
        'Dreaming is off; evidence is accumulating, but promotion is disabled.',
    });

    settings.memory.dreaming.enabled = true;
    settings.memory.enabled = false;
    expect(resolveObserverActivationStatus(settings)).toMatchObject({
      state: 'evidence_accumulating',
      active: false,
      reason: 'memory_disabled',
      message:
        'Memory is off; evidence is accumulating, but observer promotion is disabled.',
    });

    settings.memory.enabled = true;
    expect(resolveObserverActivationStatus(settings)).toMatchObject({
      state: 'evidence_accumulating',
      active: false,
      reason: 'embeddings_unavailable',
      message: 'Insight emission paused: embeddings unavailable.',
    });

    settings.memory.embeddings.enabled = true;
    settings.memory.embeddings.provider = 'openai';
    expect(resolveObserverActivationStatus(settings)).toMatchObject({
      state: 'active',
      active: true,
      message: 'Observer is active.',
    });
  });

  it('requires the persisted owner approver to remain a verified member', async () => {
    const settings = configuredObserverSettings();
    settings.memory.enabled = true;
    settings.memory.dreaming.enabled = true;
    const conversations = {
      getConversationByExternalRef: async () => ({
        id: 'conversation:slack_owner:sl:D123',
        kind: 'direct',
      }),
      listParticipantExternalUserIds: async () => [],
      listConversationApprovers: async () => [{ externalUserId: 'U123' }],
    } as never;

    await expect(
      resolveVerifiedObserverActivationStatus(
        settings,
        'default',
        conversations,
      ),
    ).resolves.toMatchObject({
      state: 'configuration_required',
      reason: 'owner_recipient_not_verified',
    });
  });
});
