import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  notificationDestinations,
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
    expect(notificationDestinations({
      routes: { [binding!.jid]: binding!.group },
      sourceAgentFolder: 'mia',
      providerAccountId: 'slack-account',
    }).map((destination) => destination.name)).toEqual([
      'gantry-demo-insurance-sales',
    ]);
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
});
