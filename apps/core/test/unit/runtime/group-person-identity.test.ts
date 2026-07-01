import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { resolveCanonicalMemoryPersonId } from '@core/runtime/group-person-identity.js';

const baseMessage = {
  id: 'message-1',
  chat_id: 'telegram:dm-1',
  sender: 'external-user-1',
  sender_name: 'External User',
  content: 'hello',
  timestamp: '2026-01-01T00:00:00.000Z',
  external_message_id: 'provider-message-1',
  provider: 'telegram',
};

describe('resolveCanonicalMemoryPersonId', () => {
  it('resolves a channel sender through provider_user identity evidence', async () => {
    const resolvePersonIdentity = vi.fn(async () => ({
      status: 'resolved' as const,
      personId: 'person:one',
      memoryHydrationEligible: true,
      verificationStatus: 'verified' as const,
    }));

    await expect(
      resolveCanonicalMemoryPersonId({
        resolvePersonIdentity,
        appId: 'app-one',
        rawUserId: 'external-user-1',
        defaultScope: 'group',
        conversationKind: 'channel',
        messages: [baseMessage],
        chatJid: 'telegram:group-1',
        providerConnectionId: 'provider-telegram-1',
      }),
    ).resolves.toBe('person:one');

    expect(resolvePersonIdentity).toHaveBeenCalledWith({
      appId: 'app-one',
      provider: 'telegram',
      providerConnectionId: 'provider-telegram-1',
      externalUserId: 'external-user-1',
      displayName: 'External User',
      evidenceType: 'provider_user',
      createIfMissing: true,
    });
  });

  it('uses web_user evidence for explicit app-session senders', async () => {
    const resolvePersonIdentity = vi.fn(async () => ({
      status: 'created' as const,
      personId: 'person:web-user',
      memoryHydrationEligible: true,
      verificationStatus: 'unverified' as const,
    }));

    await expect(
      resolveCanonicalMemoryPersonId({
        resolvePersonIdentity,
        appId: 'app-one',
        rawUserId: 'external-ci',
        defaultScope: 'group',
        conversationKind: 'channel',
        messages: [{ ...baseMessage, provider: 'app', sender: 'external-ci' }],
        chatJid: 'app:app-one:conv-1',
        identityEvidenceType: 'web_user',
        systemSenderIds: ['sdk'],
      }),
    ).resolves.toBe('person:web-user');

    expect(resolvePersonIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'app',
        evidenceType: 'web_user',
        externalUserId: 'external-ci',
      }),
    );
  });

  it('skips app-session system senders without resolving a person', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const resolvePersonIdentity = vi.fn();

    await expect(
      resolveCanonicalMemoryPersonId({
        resolvePersonIdentity,
        publishRuntimeEvent,
        appId: 'app-one',
        rawUserId: 'sdk',
        defaultScope: 'group',
        conversationKind: 'channel',
        messages: [{ ...baseMessage, provider: 'app', sender: 'sdk' }],
        chatJid: 'app:app-one:conv-1',
        identityEvidenceType: 'web_user',
        systemSenderIds: ['sdk'],
      }),
    ).resolves.toBeUndefined();

    expect(resolvePersonIdentity).not.toHaveBeenCalled();
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.MEMORY_HYDRATION_DECISION,
        payload: expect.objectContaining({
          provider: 'app',
          reason: 'system_sender',
        }),
      }),
    );
  });

  it('records retired aliases as non-hydratable instead of returning a person id', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await expect(
      resolveCanonicalMemoryPersonId({
        resolvePersonIdentity: vi.fn(async () => {
          throw new Error(
            'Alias is retired and cannot resolve active personal memory.',
          );
        }),
        publishRuntimeEvent,
        appId: 'app-one',
        rawUserId: 'external-user-1',
        defaultScope: 'user',
        conversationKind: 'dm',
        messages: [baseMessage],
        chatJid: 'telegram:dm-1',
      }),
    ).resolves.toBeUndefined();

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.IDENTITY_RESOLVED,
        payload: expect.objectContaining({
          status: 'retired_alias',
          memoryHydrationEligible: false,
        }),
      }),
    );
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.MEMORY_HYDRATION_DECISION,
        payload: expect.objectContaining({
          reason: 'retired_alias',
          memoryHydrationEligible: false,
        }),
      }),
    );
  });

  it('skips dm personal memory when resolution infrastructure errors', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await expect(
      resolveCanonicalMemoryPersonId({
        resolvePersonIdentity: vi.fn(async () => {
          throw new Error('database unavailable');
        }),
        publishRuntimeEvent,
        appId: 'app-one',
        rawUserId: 'external-user-1',
        defaultScope: 'user',
        conversationKind: 'dm',
        messages: [baseMessage],
        chatJid: 'telegram:dm-1',
      }),
    ).resolves.toBeUndefined();

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.IDENTITY_RESOLVED,
        payload: expect.objectContaining({
          status: 'resolver_error',
          memoryHydrationEligible: false,
        }),
      }),
    );
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.MEMORY_HYDRATION_DECISION,
        payload: expect.objectContaining({
          reason: 'resolver_error',
          memoryHydrationEligible: false,
        }),
      }),
    );
  });

  it('does not fall back to raw sender ids for channel turns when resolution fails', async () => {
    await expect(
      resolveCanonicalMemoryPersonId({
        resolvePersonIdentity: vi.fn(async () => {
          throw new Error('database unavailable');
        }),
        appId: 'app-one',
        rawUserId: 'external-user-1',
        defaultScope: 'group',
        conversationKind: 'channel',
        messages: [baseMessage],
        chatJid: 'telegram:group-1',
      }),
    ).resolves.toBeUndefined();
  });
});
