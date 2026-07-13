import { describe, expect, it, vi } from 'vitest';

import { handleActiveNewSessionCommand } from '@core/app/bootstrap/runtime-services-active-new.js';

describe('handleActiveNewSessionCommand', () => {
  it('preserves the agent-qualified queue key when advancing the cursor', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const app = {
      queue: { stopGroup: vi.fn(() => true) },
      clearSessionForChatJid: vi.fn(async () => undefined),
      setAgentCursor: vi.fn(),
      saveState: vi.fn(async () => undefined),
    };
    const message = {
      id: 'msg-1',
      body: '/new',
      timestamp: '2026-06-29T00:00:00.000Z',
      sender: 'user-1',
    };

    const handled = await handleActiveNewSessionCommand({
      app,
      channelWiring: { sendMessage } as any,
      opsRepository: {
        getAgentTurnContext: vi.fn(async () => ({
          agentSessionId: 'session-1',
        })),
      } as any,
      collectSessionMemory: vi.fn(async () => ({ saved: 0 })) as any,
      logger: { warn: vi.fn() },
      group: {
        folder: 'alpha',
        conversationKind: 'channel',
        providerAccountId: 'slack_alpha',
      },
      appId: 'app-one',
      chatJid: 'sl:C123',
      queueJid: 'sl:C123::thread:T1::agent:agent%3Aalpha',
      threadId: 'T1',
      message: message as any,
    });

    expect(handled).toBe(true);
    expect(app.clearSessionForChatJid).toHaveBeenCalledWith(
      'sl:C123::thread:T1::agent:agent%3Aalpha',
      'T1',
      { memoryUserId: undefined, providerAccountId: 'slack_alpha' },
    );
    expect(app.setAgentCursor).toHaveBeenCalledWith(
      'sl:C123::thread:T1::agent:agent%3Aalpha',
      expect.any(String),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      'Started a fresh session.',
      {
        durability: 'required',
        messageOptions: { threadId: 'T1', providerAccountId: 'slack_alpha' },
      },
    );
  });

  it('resets an active DM using the canonical person identity', async () => {
    const app = {
      queue: { stopGroup: vi.fn(() => true) },
      clearSessionForChatJid: vi.fn(async () => undefined),
      setAgentCursor: vi.fn(),
      saveState: vi.fn(async () => undefined),
    };
    const getAgentTurnContext = vi.fn(async () => ({
      agentSessionId: 'session-1',
    }));
    const resolvePersonIdentity = vi.fn(async () => ({
      status: 'resolved' as const,
      personId: 'person:canonical',
      memoryHydrationEligible: true,
      verificationStatus: 'verified' as const,
    }));
    const message = {
      id: 'msg-1',
      chat_jid: 'sl:D123',
      provider: 'slack',
      body: '/new',
      content: '/new',
      timestamp: '2026-06-29T00:00:00.000Z',
      sender: 'U123',
      sender_name: 'Alice',
    };

    await handleActiveNewSessionCommand({
      app,
      channelWiring: { sendMessage: vi.fn(async () => undefined) } as any,
      opsRepository: { getAgentTurnContext } as any,
      collectSessionMemory: vi.fn(async () => ({ saved: 0 })) as any,
      logger: { warn: vi.fn() },
      group: {
        folder: 'alpha',
        conversationKind: 'dm',
        providerAccountId: 'slack_alpha',
      },
      appId: 'app-one',
      resolvePersonIdentity,
      normalizeProviderId: (provider) => provider,
      executionAdapter: { id: 'test-provider' } as any,
      chatJid: 'sl:D123',
      queueJid: 'sl:D123::agent:agent%3Aalpha',
      message: message as any,
    });

    expect(resolvePersonIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-one',
        provider: 'slack',
        providerAccountId: 'slack_alpha',
        externalUserId: 'U123',
      }),
    );
    expect(getAgentTurnContext).toHaveBeenCalledWith(
      expect.objectContaining({ memoryUserId: 'person:canonical' }),
    );
    expect(app.clearSessionForChatJid).toHaveBeenCalledWith(
      'sl:D123::agent:agent%3Aalpha',
      undefined,
      {
        memoryUserId: 'person:canonical',
        providerAccountId: 'slack_alpha',
      },
    );
  });
});
