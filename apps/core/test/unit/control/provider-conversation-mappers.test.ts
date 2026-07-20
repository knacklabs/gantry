import { describe, expect, it } from 'vitest';

import { conversationInstallToResponse } from '@core/control/server/routes/provider-conversation-mappers.js';

describe('provider conversation mappers', () => {
  it('exposes only agent config from an install memory route', () => {
    const response = conversationInstallToResponse({
      id: 'install-1',
      appId: 'default',
      agentId: 'agent:main',
      providerAccountId: 'slack-main',
      conversationId: 'conversation-1',
      displayName: 'Main',
      status: 'active',
      memoryScope: 'conversation',
      memorySubject: {
        kind: 'conversation',
        appId: 'default',
        conversationId: 'conversation-1',
        route: {
          trigger: '@Main',
          requiresTrigger: true,
          agentConfig: { model: 'opus' },
        },
      },
      permissionPolicyIds: [],
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    } as never);

    expect(response.routeConfig).toEqual({ agentConfig: { model: 'opus' } });
  });
});
