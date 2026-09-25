import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  notificationAccessForAgent,
  notificationDestinations,
  notificationOrigin,
  sendNotification,
} from '@core/application/core-tools/send-notification.js';
import type { ConversationRoute } from '@core/domain/types.js';
import { bindingRowToGroup } from '@core/adapters/storage/postgres/repositories/canonical-binding-repository.postgres.js';
import {
  createCoreToolRegistry,
  type CoreToolRegistryDeps,
} from '@core/runtime/core-tools/registry.js';
import { createCoreToolSchemas } from '@core/runtime/core-tools/schemas.js';

const route = (name: string, folder: string): ConversationRoute => ({
  name,
  folder,
  trigger: '@mia',
  added_at: '2026-09-23T00:00:00Z',
  providerAccountId: 'slack-account',
  conversationKind: 'channel',
});

const claimReviewText = (claimId = 'CLM-1234') => `${claimId} needs review.

MotoBuddy's view: Needs manual review
Reason: The evidence must be checked by an authorized reviewer.
Confidence: Medium
Attention needed: Verify the evidence against the registered incident.`;

describe('send notification', () => {
  it('uses the conversation title when an install is named after the agent', () => {
    const binding = bindingRowToGroup({
      id: 'conversation-route:sl:C-SALES::agent:agent%3Amia::provider_account:slack-account',
      agentId: 'agent:mia',
      providerAccountId: 'slack-account',
      conversationId: 'conversation:slack-account:sl:C-SALES',
      threadId: null,
      status: 'active',
      conversationExternalRefJson: JSON.stringify({ jid: 'sl:C-SALES' }),
      conversationKind: 'channel',
      memorySubjectJson: JSON.stringify({ route: { trigger: '@MIA' } }),
      displayName: 'MIA',
      conversationTitle: 'gantry-demo-insurance-sales',
      createdAt: '2026-09-23T00:00:00Z',
    });
    expect(binding?.group.name).toBe('MIA');
    expect(
      notificationDestinations({
        routes: { [binding!.jid]: binding!.group },
        sourceAgentFolder: 'mia',
        providerAccountId: 'slack-account',
      }).map((destination) => destination.name),
    ).toEqual(['gantry-demo-insurance-sales']);
  });

  function registry(
    allowedToolRules: string[],
    sendMessage = vi.fn().mockResolvedValue(undefined),
  ) {
    return createCoreToolRegistry({
      context: {
        sourceAgentFolder: 'mia',
        conversationId: 'sl:C-CUSTOMER',
        providerAccountId: 'slack-account',
        allowedToolRules,
        permissionMode: 'default',
      },
      notificationDestinations: [
        {
          name: 'gantry-demo-insurance-sales',
          jid: 'sl:C-SALES',
          providerAccountId: 'slack-account',
        },
      ],
      sendMessage,
      schemas: createCoreToolSchemas(z),
    } as unknown as CoreToolRegistryDeps);
  }

  it('exposes the tool only when selected and refuses unknown channels', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    expect(registry([], sendMessage).get('send_notification')).toBeUndefined();
    const selected = registry(['mcp__gantry__send_notification'], sendMessage);
    expect(selected.get('send_notification')).toBeDefined();
    const denied = await selected.execute('send_notification', {
      destination: 'unknown',
      text: 'Not delivered',
    });
    expect(denied.isError).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
    const sent = await selected.execute('send_notification', {
      destination: '#gantry-demo-insurance-sales',
      text: 'Claim CLM-123 submitted for review.',
    });
    expect(sent.isError).not.toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C-SALES',
      'Claim CLM-123 submitted for review.',
      { providerAccountId: 'slack-account' },
    );
  });

  it('does not expose internal channel errors for a failed claim review', async () => {
    const selected = registry(['mcp__gantry__send_notification']);
    const result = await selected.execute('send_notification', {
      destination: '#missing-internal-channel',
      text: claimReviewText(),
      review_claim_id: 'CLM-1234',
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      'The claim review request could not be confirmed',
    );
    expect(JSON.stringify(result)).not.toContain('missing-internal-channel');
    expect(JSON.stringify(result)).not.toContain('Available channels');
  });

  it('lists only Slack channels installed for the current agent and account', () => {
    const destinations = notificationDestinations({
      routes: {
        'sl:C-SALES': route('gantry-demo-insurance-sales', 'mia'),
        'sl:C-OTHER': route('private', 'another-agent'),
        'sl:D-DM': { ...route('dm', 'mia'), conversationKind: 'dm' },
        'tg:12345678': route('telegram', 'mia'),
      },
      sourceAgentFolder: 'mia',
      providerAccountId: 'slack-account',
    });
    expect(destinations).toEqual([
      {
        name: 'gantry-demo-insurance-sales',
        jid: 'sl:C-SALES',
        providerAccountId: 'slack-account',
      },
    ]);
  });

  it('lets an app test session address the agent installed Slack channels', () => {
    const destinations = notificationDestinations({
      routes: {
        'sl:C-SALES': route('gantry-demo-insurance-sales', 'mia'),
        'sl:C-OTHER': route('private', 'another-agent'),
      },
      sourceAgentFolder: 'mia',
    });
    expect(destinations.map((destination) => destination.name)).toEqual([
      'gantry-demo-insurance-sales',
    ]);
  });

  it('resolves a Telegram origin only from the same agent and account', () => {
    const telegramRoute = {
      ...route('vishwa', 'mia'),
      providerAccountId: 'telegram-account',
      conversationKind: 'direct' as const,
    };
    const routes = {
      'tg:123': telegramRoute,
      'tg:999': { ...telegramRoute, folder: 'another-agent' },
    };
    expect(
      notificationOrigin({
        routes,
        sourceAgentFolder: 'mia',
        sourceJid: 'tg:123',
        providerAccountId: 'telegram-account',
      }),
    ).toEqual({ jid: 'tg:123', providerAccountId: 'telegram-account' });
    expect(
      notificationOrigin({
        routes,
        sourceAgentFolder: 'mia',
        sourceJid: 'tg:999',
        providerAccountId: 'telegram-account',
      }),
    ).toBeUndefined();
  });

  it('gives each Telegram bot only its own installed Slack notification destinations', () => {
    const routes = {
      'tg:123': {
        ...route('customer', 'mia'),
        providerAccountId: 'telegram-account',
        conversationKind: 'direct' as const,
      },
      'sl:C-SALES': route('gantry-demo-insurance-sales', 'mia'),
      'sl:C-OTHER': route('private', 'another-agent'),
    };
    const access = notificationAccessForAgent({
      routes,
      sourceAgentFolder: 'mia',
      sourceJid: 'tg:123',
      providerAccountId: 'telegram-account',
    });
    expect(access.notificationOrigin).toEqual({
      jid: 'tg:123',
      providerAccountId: 'telegram-account',
    });
    expect(access.notificationDestinations.map((item) => item.jid)).toEqual([
      'sl:C-SALES',
    ]);
  });

  it('sends only to an allowed destination', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const destinations = [
      {
        name: 'gantry-demo-insurance-sales',
        jid: 'sl:C-SALES',
        providerAccountId: 'slack-account',
      },
    ];
    await sendNotification({
      destination: '#gantry-demo-insurance-sales',
      text: 'Claim CLM-123 submitted for review.',
      destinations,
      sendMessage,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C-SALES',
      'Claim CLM-123 submitted for review.',
      { providerAccountId: 'slack-account' },
    );
    await expect(
      sendNotification({
        destination: '#gantry-notifications',
        text: 'Not delivered',
        destinations,
        sendMessage,
      }),
    ).rejects.toThrow(
      'Requested destination "#gantry-notifications" is unavailable or ambiguous. Available channels: #gantry-demo-insurance-sales.',
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await sendNotification({
      destination: '#C-SALES',
      text: 'Channel ID syntax also works.',
      destinations,
      sendMessage,
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('adds review buttons only after both evidence types are stored', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith('/review-card-sent')
            ? '{}'
            : JSON.stringify({
                claim: { status: 'submitted_for_review' },
                evidence: [
                  { documentType: 'damage_photo' },
                  { documentType: 'repair_estimate' },
                ],
              }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    await sendNotification({
      destination: '#gantry-demo-insurance-sales',
      text: claimReviewText(),
      claimReview: {
        claimId: 'CLM-1234',
        origin: { jid: 'sl:C-TEST', providerAccountId: 'slack-account' },
      },
      reviewChannelName: 'gantry-demo-insurance-sales',
      reviewServiceUrl: 'http://127.0.0.1:14319',
      fetcher,
      destinations: [
        {
          name: 'gantry-demo-insurance-sales',
          jid: 'sl:C-SALES',
          providerAccountId: 'slack-account',
        },
        {
          name: 'gantry-test-channel',
          jid: 'sl:C-TEST',
          providerAccountId: 'slack-account',
        },
      ],
      sendMessage,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C-SALES',
      expect.stringContaining('**View:** **Accept for assessment**'),
      expect.objectContaining({
        actionAffordances: [
          expect.objectContaining({
            kind: 'claim_review_decision',
            decision: 'approve',
            label: 'Accept for assessment',
          }),
          expect.objectContaining({
            kind: 'claim_review_decision',
            decision: 'decline',
          }),
        ],
      }),
    );
    expect(sendMessage.mock.calls[0]?.[1]).not.toContain(
      'Repair estimate not received',
    );
    expect(
      sendMessage.mock.calls[0]?.[2]?.actionAffordances?.[0]?.outcomeJid,
    ).toBe('sl:C-TEST');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('posts a Slack review card for a Telegram-origin claim without changing the outcome route', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith('/review-card-sent')
            ? '{}'
            : JSON.stringify({
                claim: { status: 'submitted_for_review' },
                evidence: [
                  { documentType: 'damage_photo' },
                  { documentType: 'repair_estimate' },
                ],
              }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    await sendNotification({
      destination: '#gantry-demo-insurance-sales',
      text: claimReviewText(),
      claimReview: {
        claimId: 'CLM-1234',
        origin: { jid: 'tg:123', providerAccountId: 'telegram-account' },
      },
      reviewChannelName: 'gantry-demo-insurance-sales',
      reviewServiceUrl: 'http://127.0.0.1:14319',
      fetcher,
      destinations: [
        {
          name: 'gantry-demo-insurance-sales',
          jid: 'sl:C-SALES',
          providerAccountId: 'slack-account',
        },
      ],
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C-SALES',
      expect.any(String),
      expect.objectContaining({
        providerAccountId: 'slack-account',
        actionAffordances: expect.arrayContaining([
          expect.objectContaining({ outcomeJid: 'tg:123' }),
        ]),
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("renders MotoBuddy's advisory as a concise two-line review", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith('/review-card-sent')
            ? '{}'
            : JSON.stringify({
                claim: { status: 'submitted_for_review' },
                evidence: [
                  { documentType: 'damage_photo' },
                  { documentType: 'repair_estimate' },
                ],
              }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    await sendNotification({
      destination: '#gantry-demo-insurance-sales',
      text: `Claim ID: CLM-1234
Policy ID: MOTOR-1001
Incident: Collision in Hyderabad
Evidence count: 2
Unverified provisional estimate total: INR 21,500
Review reason: The photo and estimate have a damage mismatch.`,
      claimReview: {
        claimId: 'CLM-1234',
        origin: { jid: 'tg:123', providerAccountId: 'telegram-account' },
      },
      reviewChannelName: 'gantry-demo-insurance-sales',
      reviewServiceUrl: 'http://127.0.0.1:14319',
      fetcher,
      destinations: [
        {
          name: 'gantry-demo-insurance-sales',
          jid: 'sl:C-SALES',
          providerAccountId: 'slack-account',
        },
      ],
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C-SALES',
      expect.stringContaining(
        '**View:** **Decline claim** — **Medium confidence.**',
      ),
      expect.objectContaining({
        providerAccountId: 'slack-account',
        actionAffordances: expect.any(Array),
      }),
    );
    const delivered = sendMessage.mock.calls[0]?.[1] as string;
    expect(delivered).toContain(':clipboard: **Motor Claim Review**');
    expect(delivered).toContain('• **Claim:** `CLM-1234`');
    expect(delivered).toContain('• **Policy:** `MOTOR-1001`');
    expect(delivered).toContain('• **Estimate:** INR 21,500 (unverified)');
    expect(delivered).toContain('**Reason:**');
    expect(delivered).not.toContain('Why this reached human review');
    expect(delivered).not.toContain('**Attention needed:**');
    expect(delivered).not.toContain(':handshake: **Human decision**');
    expect(delivered).not.toContain(
      "This is MotoBuddy's non-binding view. The final decision belongs to the human reviewer.",
    );
    expect(delivered).toContain(
      'I will store your response for future decisions.',
    );
    expect(
      delivered
        .trim()
        .endsWith('I will store your response for future decisions.'),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('normalizes a non-binary model view to accept or decline', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith('/review-card-sent')
            ? '{}'
            : JSON.stringify({
                claim: { status: 'submitted_for_review' },
                evidence: [
                  { documentType: 'damage_photo' },
                  { documentType: 'repair_estimate' },
                ],
              }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    await sendNotification({
      destination: '#gantry-demo-insurance-sales',
      text: `${claimReviewText()}\nMismatch between the damage photo and estimate.`,
      claimReview: {
        claimId: 'CLM-1234',
        origin: { jid: 'tg:123', providerAccountId: 'telegram-account' },
      },
      reviewChannelName: 'gantry-demo-insurance-sales',
      reviewServiceUrl: 'http://127.0.0.1:14319',
      fetcher,
      destinations: [
        {
          name: 'gantry-demo-insurance-sales',
          jid: 'sl:C-SALES',
          providerAccountId: 'slack-account',
        },
      ],
      sendMessage,
    });

    const delivered = sendMessage.mock.calls[0]?.[1] as string;
    expect(delivered).toContain(
      '**View:** **Decline claim** — **Medium confidence.**',
    );
    expect(delivered).not.toContain('**View:** **Needs manual review**');
  });

  it('sends a review card for a damage photo and claim form while flagging the missing estimate', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith('/review-card-sent')
            ? '{}'
            : JSON.stringify({
                claim: { status: 'submitted_for_review' },
                evidence: [
                  { documentType: 'damage_photo' },
                  { documentType: 'incident_report' },
                ],
              }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    await sendNotification({
      destination: '#gantry-demo-insurance-sales',
      text: claimReviewText(),
      claimReview: {
        claimId: 'CLM-1234',
        origin: { jid: 'sl:C-TEST', providerAccountId: 'slack-account' },
      },
      reviewChannelName: 'gantry-demo-insurance-sales',
      reviewServiceUrl: 'http://127.0.0.1:14319',
      fetcher,
      destinations: [
        {
          name: 'gantry-demo-insurance-sales',
          jid: 'sl:C-SALES',
          providerAccountId: 'slack-account',
        },
        {
          name: 'gantry-test-channel',
          jid: 'sl:C-TEST',
          providerAccountId: 'slack-account',
        },
      ],
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C-SALES',
      expect.stringContaining('Repair estimate not received'),
      expect.objectContaining({
        actionAffordances: expect.arrayContaining([
          expect.objectContaining({ decision: 'approve' }),
          expect.objectContaining({ decision: 'decline' }),
        ]),
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('routes each review outcome to the channel that originated that claim', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith('/review-card-sent')
            ? '{}'
            : JSON.stringify({
                claim: { status: 'submitted_for_review' },
                evidence: [
                  { documentType: 'damage_photo' },
                  { documentType: 'repair_estimate' },
                ],
              }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const destinations = [
      {
        name: 'gantry-demo-insurance-sales',
        jid: 'sl:C-SALES',
        providerAccountId: 'slack-account',
      },
      { name: 'client-a', jid: 'sl:C-A', providerAccountId: 'slack-account' },
      { name: 'client-b', jid: 'sl:C-B', providerAccountId: 'slack-account' },
    ];
    for (const [claimId, sourceJid] of [
      ['CLM-AAAA', 'sl:C-A'],
      ['CLM-BBBB', 'sl:C-B'],
    ]) {
      await sendNotification({
        destination: '#gantry-demo-insurance-sales',
        text: claimReviewText(claimId),
        claimReview: {
          claimId,
          origin: { jid: sourceJid, providerAccountId: 'slack-account' },
        },
        reviewChannelName: 'gantry-demo-insurance-sales',
        reviewServiceUrl: 'http://127.0.0.1:14319',
        fetcher,
        destinations,
        sendMessage,
      });
    }
    expect(
      sendMessage.mock.calls.map(
        (call) => call[2].actionAffordances[0].outcomeJid,
      ),
    ).toEqual(['sl:C-A', 'sl:C-B']);
  });

  it('rejects an unbound origin before posting a review card', async () => {
    const sendMessage = vi.fn();
    const fetcher = vi.fn();
    await expect(
      sendNotification({
        destination: '#gantry-demo-insurance-sales',
        text: 'Claim CLM-AAAA needs review',
        claimReview: { claimId: 'CLM-AAAA' },
        reviewChannelName: 'gantry-demo-insurance-sales',
        reviewServiceUrl: 'http://127.0.0.1:14319',
        fetcher,
        destinations: [
          {
            name: 'gantry-demo-insurance-sales',
            jid: 'sl:C-SALES',
            providerAccountId: 'slack-account',
          },
        ],
        sendMessage,
      }),
    ).rejects.toThrow('bound originating conversation');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [{ documentType: 'damage_photo' }],
    [{ documentType: 'incident_report' }],
    [{ documentType: 'repair_estimate' }],
  ])(
    'keeps an incomplete evidence set out of internal review',
    async (...evidence) => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const fetcher = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              claim: { status: 'submitted_for_review' },
              evidence,
            }),
            { status: 200 },
          ),
      ) as unknown as typeof fetch;

      await expect(
        sendNotification({
          destination: '#gantry-demo-insurance-sales',
          text: claimReviewText(),
          claimReview: {
            claimId: 'CLM-1234',
            origin: { jid: 'sl:C-TEST', providerAccountId: 'slack-account' },
          },
          reviewChannelName: 'gantry-demo-insurance-sales',
          reviewServiceUrl: 'http://127.0.0.1:14319',
          fetcher,
          destinations: [
            {
              name: 'gantry-demo-insurance-sales',
              jid: 'sl:C-SALES',
              providerAccountId: 'slack-account',
            },
            {
              name: 'gantry-test-channel',
              jid: 'sl:C-TEST',
              providerAccountId: 'slack-account',
            },
          ],
          sendMessage,
        }),
      ).rejects.toThrow('Claim review requires');
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );
});
