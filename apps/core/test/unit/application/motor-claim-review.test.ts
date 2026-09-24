import { describe, expect, it, vi } from 'vitest';
import { decideMotorClaimReview } from '@core/application/claims/motor-claim-review.js';
import type { ConversationRoute } from '@core/domain/types.js';

const route = (name: string): ConversationRoute => ({
  name,
  folder: 'mia',
  trigger: '@mia',
  added_at: '2026-09-23T00:00:00Z',
  providerAccountId: 'slack-account',
  conversationKind: 'channel',
});
const routes = {
  'sl:C-SALES': route('gantry-demo-insurance-sales'),
  'sl:C-TEST': route('gantry-test-channel'),
  'sl:C-CLIENT-B': route('client-b'),
};

const input = {
  claimId: 'CLM-1234',
  decision: 'approve' as const,
  userId: 'U-APPROVER',
  providerAccountId: 'slack-account',
  sourceAgentFolder: 'mia',
  reviewJid: 'sl:C-SALES',
  outcomeJid: 'sl:C-TEST',
  routes,
  reviewChannelName: 'gantry-demo-insurance-sales',
  serviceUrl: 'http://127.0.0.1:14319',
};

describe('motor claim review', () => {
  it('saves a decision, notifies the customer channel, and records delivery', async () => {
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith('/decision')
            ? JSON.stringify({
                claim: { claimId: 'CLM-1234' },
                decision: {
                  decisionId: 'DEC-1',
                  notificationStatus: 'pending',
                },
              })
            : '{}',
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const result = await decideMotorClaimReview({
      ...input,
      fetcher,
      sendMessage,
    });
    expect(result.state).toBe('applied');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C-TEST',
      expect.stringContaining('accepted for further assessment'),
      'slack-account',
    );
  });

  it('delivers a decline and its reason to the outcome channel', async () => {
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith('/decision')
            ? JSON.stringify({
                claim: { claimId: 'CLM-1234' },
                decision: {
                  decisionId: 'DEC-2',
                  reason: 'Documents do not match this claim',
                  notificationStatus: 'pending',
                },
              })
            : '{}',
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const result = await decideMotorClaimReview({
      ...input,
      decision: 'decline',
      reason: 'Documents do not match this claim',
      fetcher,
      sendMessage,
    });
    expect(result.state).toBe('applied');
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C-TEST',
      expect.stringContaining(
        'declined in internal review. Reason: Documents do not match this claim.',
      ),
      'slack-account',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('delivers a decision to another bound client channel from its card', async () => {
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith('/decision')
            ? JSON.stringify({
                claim: { claimId: 'CLM-1234' },
                decision: {
                  decisionId: 'DEC-3',
                  notificationStatus: 'pending',
                },
              })
            : '{}',
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const result = await decideMotorClaimReview({
      ...input,
      outcomeJid: 'sl:C-CLIENT-B',
      fetcher,
      sendMessage,
    });
    expect(result.state).toBe('applied');
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C-CLIENT-B',
      expect.stringContaining('accepted for further assessment'),
      'slack-account',
    );
  });

  it('delivers a Slack approval decision to the bound Telegram origin using its own account', async () => {
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith('/decision')
            ? JSON.stringify({
                claim: { claimId: 'CLM-1234' },
                decision: {
                  decisionId: 'DEC-TG',
                  notificationStatus: 'pending',
                },
              })
            : '{}',
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const result = await decideMotorClaimReview({
      ...input,
      outcomeJid: 'tg:123',
      routes: {
        ...routes,
        'tg:123': {
          ...route('vishwa'),
          providerAccountId: 'telegram-account',
          conversationKind: 'direct',
        },
      },
      fetcher,
      sendMessage,
    });

    expect(result.state).toBe('applied');
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:123',
      expect.stringContaining('accepted for further assessment'),
      'telegram-account',
    );
    expect(sendMessage.mock.calls[0]?.[1]).not.toContain('<@U-APPROVER>');
  });

  it("refuses to send a decision to another agent's Telegram conversation", async () => {
    const fetcher = vi.fn();
    const sendMessage = vi.fn();
    const result = await decideMotorClaimReview({
      ...input,
      outcomeJid: 'tg:999',
      routes: {
        ...routes,
        'tg:999': {
          ...route('other'),
          folder: 'other-agent',
          providerAccountId: 'telegram-account',
          conversationKind: 'direct',
        },
      },
      fetcher,
      sendMessage,
    });
    expect(result.state).toBe('denied');
    expect(fetcher).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects an unbound destination before changing the claim', async () => {
    const fetcher = vi.fn();
    const sendMessage = vi.fn();
    const result = await decideMotorClaimReview({
      ...input,
      outcomeJid: 'sl:C-OTHER',
      fetcher,
      sendMessage,
    });
    expect(result.state).toBe('denied');
    expect(fetcher).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('requires a decline reason', async () => {
    const fetcher = vi.fn();
    const result = await decideMotorClaimReview({
      ...input,
      decision: 'decline',
      fetcher,
      sendMessage: vi.fn(),
    });
    expect(result.state).toBe('needs_input');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not call an unrecorded review card an already-decided claim', async () => {
    const sendMessage = vi.fn();
    const result = await decideMotorClaimReview({
      ...input,
      decision: 'decline',
      reason: 'Documents do not match this claim',
      fetcher: vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'CLAIM_REVIEW_CARD_NOT_POSTED' }),
            {
              status: 409,
            },
          ),
      ) as unknown as typeof fetch,
      sendMessage,
    });
    expect(result.state).toBe('stale');
    expect(result.receipt).toContain('review request was not recorded');
    expect(result.receipt).not.toContain('already been decided');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
