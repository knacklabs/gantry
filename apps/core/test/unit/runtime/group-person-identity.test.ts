import { describe, expect, it, vi } from 'vitest';

import { normalizeProviderId } from '@core/channels/provider-registry.js';
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
        conversationKind: 'channel',
        messages: [baseMessage],
        chatJid: 'telegram:group-1',
        providerAccountId: 'provider-telegram-1',
      }),
    ).resolves.toBeUndefined();

    expect(resolvePersonIdentity).toHaveBeenCalledWith(
      {
        appId: 'app-one',
        provider: 'telegram',
        providerAccountId: 'provider-telegram-1',
        externalUserId: 'external-user-1',
        displayName: 'External User',
        evidenceType: 'provider_user',
        createIfMissing: false,
      },
      expect.any(Function),
    );
  });

  it.each([
    ['tg:dm-1', 'telegram'],
    ['telegram:dm-1', 'telegram'],
    ['sl:D123', 'slack'],
    ['slack:D123', 'slack'],
  ])('normalizes the %s JID provider to %s', async (chatJid, provider) => {
    const resolvePersonIdentity = vi.fn(async () => ({
      status: 'resolved' as const,
      personId: 'person:one',
      memoryHydrationEligible: true,
      verificationStatus: 'verified' as const,
    }));

    await resolveCanonicalMemoryPersonId({
      resolvePersonIdentity,
      normalizeProviderId,
      appId: 'app-one',
      rawUserId: 'external-user-1',
      conversationKind: 'dm',
      messages: [{ ...baseMessage, provider: '' }],
      chatJid,
    });

    expect(resolvePersonIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ provider }),
      expect.any(Function),
    );
  });

  it('canonicalizes an explicit message provider before alias resolution', async () => {
    const resolvePersonIdentity = vi.fn(async () => ({
      status: 'resolved' as const,
      personId: 'person:one',
      memoryHydrationEligible: true,
      verificationStatus: 'verified' as const,
    }));

    await resolveCanonicalMemoryPersonId({
      resolvePersonIdentity,
      normalizeProviderId,
      appId: 'app-one',
      rawUserId: 'external-user-1',
      conversationKind: 'dm',
      messages: [{ ...baseMessage, provider: ' SL ' }],
      chatJid: 'tg:dm-1',
    });

    expect(resolvePersonIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'slack' }),
      expect.any(Function),
    );
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
        conversationKind: 'channel',
        messages: [{ ...baseMessage, provider: 'app', sender: 'external-ci' }],
        chatJid: 'app:app-one:conv-1',
        identityEvidenceType: 'web_user',
        systemSenderIds: ['sdk'],
      }),
    ).resolves.toBeUndefined();

    expect(resolvePersonIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'app',
        evidenceType: 'web_user',
        externalUserId: 'external-ci',
        createIfMissing: false,
      }),
      expect.any(Function),
    );
  });

  it('does not create a person for an unknown channel sender', async () => {
    const resolvePersonIdentity = vi.fn(
      async (input: { createIfMissing?: boolean }) => {
        expect(input.createIfMissing).toBe(false);
        return {
          status: 'unresolved' as const,
          personId: null,
          memoryHydrationEligible: false,
        };
      },
    );

    await expect(
      resolveCanonicalMemoryPersonId({
        resolvePersonIdentity,
        appId: 'app-one',
        rawUserId: 'new-group-sender',
        conversationKind: 'channel',
        messages: [{ ...baseMessage, sender: 'new-group-sender' }],
        chatJid: 'sl:C123',
      }),
    ).resolves.toBeUndefined();

    expect(resolvePersonIdentity).toHaveBeenCalledTimes(1);
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

  it('keeps provider thread ids in identity payloads without using them as runtime-event foreign keys', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);

    await expect(
      resolveCanonicalMemoryPersonId({
        resolvePersonIdentity: vi.fn(async () => ({
          status: 'resolved' as const,
          personId: 'person:one',
          memoryHydrationEligible: true,
          verificationStatus: 'verified' as const,
        })),
        publishRuntimeEvent,
        appId: 'app-one',
        rawUserId: 'external-user-1',
        conversationKind: 'channel',
        messages: [baseMessage],
        chatJid: 'sl:C123',
        threadId: '1783348894.205129',
        providerAccountId: 'slack_default',
      }),
    ).resolves.toBeUndefined();

    const identityEvent = publishRuntimeEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find(
        (event) => event.eventType === RUNTIME_EVENT_TYPES.IDENTITY_RESOLVED,
      );
    const hydrationEvent = publishRuntimeEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find(
        (event) =>
          event.eventType === RUNTIME_EVENT_TYPES.MEMORY_HYDRATION_DECISION,
      );
    expect(identityEvent).not.toHaveProperty('threadId');
    expect(identityEvent?.payload).toEqual(
      expect.objectContaining({
        conversationJid: 'sl:C123',
        threadId: '1783348894.205129',
      }),
    );
    expect(hydrationEvent).not.toHaveProperty('threadId');
    expect(hydrationEvent?.payload).toEqual(
      expect.objectContaining({
        conversationJid: 'sl:C123',
        threadId: '1783348894.205129',
      }),
    );
  });

  it('uses canonical conversation and thread ids as runtime-event foreign keys', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const conversationJid = 'conversation:slack_default:sl:D123';
    const threadId = 'thread:slack_default:sl:D123:1783348894.205129';

    await resolveCanonicalMemoryPersonId({
      resolvePersonIdentity: vi.fn(async () => ({
        status: 'resolved' as const,
        personId: 'person:one',
        memoryHydrationEligible: true,
        verificationStatus: 'verified' as const,
      })),
      publishRuntimeEvent,
      appId: 'app-one',
      rawUserId: 'external-user-1',
      conversationKind: 'dm',
      messages: [{ ...baseMessage, provider: 'sl' }],
      chatJid: conversationJid,
      threadId,
    });

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversationJid,
        threadId,
        payload: expect.objectContaining({ conversationJid, threadId }),
      }),
    );
  });

  it('does not publish legacy person ids that embed a raw provider alias', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const legacyPersonId = 'user:app-one:telegram:external-user-1';

    await expect(
      resolveCanonicalMemoryPersonId({
        resolvePersonIdentity: vi.fn(async () => ({
          status: 'resolved' as const,
          personId: legacyPersonId,
          memoryHydrationEligible: true,
          verificationStatus: 'verified' as const,
        })),
        publishRuntimeEvent,
        appId: 'app-one',
        rawUserId: 'external-user-1',
        conversationKind: 'dm',
        messages: [baseMessage],
        chatJid: 'telegram:dm-1',
      }),
    ).resolves.toBe(legacyPersonId);

    for (const [event] of publishRuntimeEvent.mock.calls) {
      expect(JSON.stringify(event)).not.toContain('external-user-1');
    }
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
        conversationKind: 'channel',
        messages: [baseMessage],
        chatJid: 'telegram:group-1',
      }),
    ).resolves.toBeUndefined();
  });
});
