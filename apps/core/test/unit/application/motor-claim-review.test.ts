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
  outcomeChannelName: 'gantry-test-channel',
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
});
