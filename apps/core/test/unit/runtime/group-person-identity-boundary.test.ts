import { describe, expect, it, vi } from 'vitest';

import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { resolveCanonicalMemoryPersonId } from '@core/runtime/group-person-identity.js';

const groupMessage = {
  id: 'message-1',
  chat_id: 'sl:C123',
  sender: 'U123',
  sender_name: 'Person One',
  content: 'hello',
  timestamp: '2026-08-01T00:00:00.000Z',
  external_message_id: 'provider-message-1',
  provider: 'slack',
};

describe('person identity boundaries', () => {
  it('never appends personal memory on group turns', async () => {
    const publishRuntimeEvent = vi.fn(
      async (_event: { eventType: string; payload?: unknown }) => undefined,
    );

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
        rawUserId: 'U123',
        conversationKind: 'channel',
        messages: [groupMessage],
        chatJid: 'sl:C123',
        providerAccountId: 'slack-account-one',
      }),
    ).resolves.toBeUndefined();

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: RUNTIME_EVENT_TYPES.MEMORY_HYDRATION_DECISION,
        payload: expect.objectContaining({
          conversationKind: 'channel',
          memoryHydrationEligible: false,
        }),
      }),
    );
    const hydrationEvent = publishRuntimeEvent.mock.calls
      .map(([event]) => event)
      .find(
        (event) =>
          event.eventType === RUNTIME_EVENT_TYPES.MEMORY_HYDRATION_DECISION,
      );
    expect(hydrationEvent?.payload).not.toHaveProperty('personId');
  });

  it('never creates identity or rewrites person scope for an unresolved group sender', async () => {
    const resolvePersonIdentity = vi.fn(async () => ({
      status: 'unresolved' as const,
      personId: null,
      memoryHydrationEligible: false,
    }));

    await expect(
      resolveCanonicalMemoryPersonId({
        resolvePersonIdentity,
        appId: 'app-one',
        rawUserId: 'unknown-sender',
        conversationKind: 'channel',
        messages: [
          {
            ...groupMessage,
            sender: 'unknown-sender',
            sender_name: 'Unknown Sender',
          },
        ],
        chatJid: 'sl:C123',
        providerAccountId: 'slack-account-one',
      }),
    ).resolves.toBeUndefined();

    expect(resolvePersonIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ createIfMissing: false }),
      expect.any(Function),
    );
  });

  it.each(['sdk', 'agent:researcher'])(
    'never mints a person for the %s system or agent sender',
    async (sender) => {
      const resolvePersonIdentity = vi.fn();

      await expect(
        resolveCanonicalMemoryPersonId({
          resolvePersonIdentity,
          appId: 'app-one',
          rawUserId: sender,
          conversationKind: 'dm',
          messages: [
            {
              ...groupMessage,
              provider: 'app',
              sender,
              sender_name: sender,
            },
          ],
          chatJid: 'app:app-one:conversation-one',
          identityEvidenceType: 'web_user',
          systemSenderIds: ['sdk', 'agent:researcher'],
        }),
      ).resolves.toBeUndefined();

      expect(resolvePersonIdentity).not.toHaveBeenCalled();
    },
  );
});
