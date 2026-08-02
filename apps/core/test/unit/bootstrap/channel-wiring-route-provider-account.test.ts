import { describe, expect, it } from 'vitest';

import { findBoundChannelForRequest } from '@core/app/bootstrap/channel-wiring-route-provider-account.js';

describe('findBoundChannelForRequest', () => {
  const jid = 'sl:C123';
  const wardenChannel = { ownsJid: (value: string) => value === jid };

  it('uses the sole live channel owned by the request agent when a persisted provider account is stale', () => {
    const channel = findBoundChannelForRequest(
      { getConversationRoutes: () => ({}) } as never,
      [
        {
          providerId: 'slack',
          providerAccountId: 'slack_warden',
          agentId: 'agent:warden',
          channel: wardenChannel,
        },
      ],
      jid,
      'slack_old',
      { agentId: 'agent:warden' },
    );

    expect(channel).toBe(wardenChannel);
  });

  it('uses the sole live channel owned by the request agent when provider account context is missing', () => {
    const channel = findBoundChannelForRequest(
      { getConversationRoutes: () => ({}) } as never,
      [
        {
          providerId: 'slack',
          providerAccountId: 'slack_warden',
          agentId: 'agent:warden',
          channel: wardenChannel,
        },
        {
          providerId: 'slack',
          providerAccountId: 'slack_scout',
          agentId: 'agent:scout',
          channel: wardenChannel,
        },
      ],
      jid,
      undefined,
      { agentId: 'agent:warden' },
    );

    expect(channel).toBe(wardenChannel);
  });

  it('does not guess without provider account context when the request agent has multiple live channels for the same JID', () => {
    const channel = findBoundChannelForRequest(
      { getConversationRoutes: () => ({}) } as never,
      [
        {
          providerId: 'slack',
          providerAccountId: 'slack_warden_one',
          agentId: 'agent:warden',
          channel: wardenChannel,
        },
        {
          providerId: 'slack',
          providerAccountId: 'slack_warden_two',
          agentId: 'agent:warden',
          channel: wardenChannel,
        },
      ],
      jid,
      undefined,
      { sourceAgentFolder: 'warden' },
    );

    expect(channel).toBeUndefined();
  });

  it('does not guess when the request agent has multiple live channels for the same JID', () => {
    const channel = findBoundChannelForRequest(
      { getConversationRoutes: () => ({}) } as never,
      [
        {
          providerId: 'slack',
          providerAccountId: 'slack_warden_one',
          agentId: 'agent:warden',
          channel: wardenChannel,
        },
        {
          providerId: 'slack',
          providerAccountId: 'slack_warden_two',
          agentId: 'agent:warden',
          channel: wardenChannel,
        },
      ],
      jid,
      'slack_old',
      { sourceAgentFolder: 'warden' },
    );

    expect(channel).toBeUndefined();
  });
});
